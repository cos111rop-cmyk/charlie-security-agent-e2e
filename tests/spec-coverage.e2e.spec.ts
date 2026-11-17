/**
 * Requirement-traceable coverage for the Charlie StoreOS Security Agent specification.
 *
 * Every test title starts with a requirement ID (e.g. [PRO-02]) that is listed in
 * docs/REQUIREMENTS_TRACEABILITY.md together with its source document and section.
 *
 * Every test also carries one mode tag, which the Playwright projects select on:
 *   @live           read-only; runs against any agent
 *   @live-mutating  creates, changes or deletes agent data; live only on a disposable terminal
 *   @mock-only      needs the mock control plane (fault injection / state inspection)
 * The fixture in ./fixtures fails a test that runs in a mode its tag does not allow.
 */
import { test, expect } from './fixtures';
import {
  AgentWsClient,
  resetMockState,
  setMockState,
  inspectMockState,
  uniqueId,
} from './ws-client';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.describe('Charlie StoreOS Security Agent - Specification Coverage', () => {
  let client: AgentWsClient;

  test.beforeEach(async () => {
    await resetMockState();
    client = new AgentWsClient();
    await client.connect();
  });

  test.afterEach(async () => {
    // Undefined when the mode guard stopped the test before beforeEach connected.
    await client?.close();
  });

  const registerTemp = (employeeId: string, extra: Record<string, any> = {}) =>
    client.send('/register/tempEmployee', {
      employeeId,
      consentGiven: true,
      firstName: 'Temp',
      familyName: 'User',
      sponserId: 'rt00001',
      ...extra,
    });

  // ===========================================================================
  // PROTOCOL: correlationID / path / payload / response envelope
  // ===========================================================================
  test('[PRO-01] Every response carries statusCode (200|400), correlationID, path, response block and timeTaken', { tag: '@live' }, async () => {
    const calls: Array<[string, Record<string, any> | undefined, number]> = [
      ['/healthCheck', undefined, 200],
      ['/userinfo', { employeeId: 'rt00001' }, 200],
      ['/userinfo', { employeeId: 'unknown_999' }, 400],
      ['/terminate/transaction', { targetCorrelationID: 'does-not-exist' }, 400],
    ];
    for (const [path, payload, expected] of calls) {
      const res = await client.send(path, payload);
      expect([200, 400]).toContain(res.statusCode);
      expect(res.statusCode).toBe(expected);
      expect(res.path).toBe(path);
      expect(res.correlationID).toBeTruthy();
      expect(res.timeTaken).toMatch(/^\d+ms$/);
      expect(res.response.actionResult).toBeDefined();
      expect(typeof res.response.actionResult.code).toBe('number');
      if (expected === 400) {
        expect(res.response.errorInfo).toBeDefined();
        expect(typeof res.response.errorInfo.code).toBe('number');
        expect(typeof res.response.errorInfo.message).toBe('string');
      } else {
        expect(res.response.errorInfo).toBeUndefined();
      }
    }
  });

  test('[PRO-02] Concurrent requests are answered with their own correlationID and never cross', { tag: '@live' }, async () => {
    const [a, b, c] = await Promise.all([
      client.send('/healthCheck', undefined, 'concurrent-A'),
      client.send('/userinfo', { employeeId: 'rt00001' }, 'concurrent-B'),
      client.send('/userinfo', { employeeId: 'unknown_999' }, 'concurrent-C'),
    ]);
    expect([a.correlationID, a.path, a.statusCode]).toEqual(['concurrent-A', '/healthCheck', 200]);
    expect([b.correlationID, b.path, b.statusCode]).toEqual(['concurrent-B', '/userinfo', 200]);
    expect([c.correlationID, c.path, c.statusCode]).toEqual(['concurrent-C', '/userinfo', 400]);
  });

  test('[PRO-03] A malformed request frame is rejected without taking the agent down', { tag: '@mock-only' }, async () => {
    const res = await client.sendRaw('this is not json');
    expect(res.statusCode).toBe(400);
    expect(res.response.errorInfo.code).toBeDefined();
    const hc = await client.send('/healthCheck');
    expect(hc.statusCode).toBe(200);
  });

  test('[PRO-04] processingMs is returned on biometric authentication, barcode authentication and biometric enrollment', { tag: '@live-mutating' }, async () => {
    const bio = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0 });
    expect(typeof bio.processingMs).toBe('number');

    const reg = await client.send('/register/barcode', { employeeId: 'rt00001', pin: '4354', validity: 300 });
    const bar = await client.send('/authenticate/barcode', {
      barcodeData: reg.response.barcodeData,
      pin: '4354',
    });
    expect(bar.statusCode).toBe(200);
    expect(typeof bar.processingMs).toBe('number');

    const login = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'SecretPassword123',
    });
    const enroll = await client.send('/register/biometric', {
      employeeId: 'rt00001',
      loginCorrelationID: login.correlationID,
    });
    expect(enroll.statusCode).toBe(200);
    expect(typeof enroll.processingMs).toBe('number');
  });

  // ===========================================================================
  // LOGGING: SecurityLog / ErrorLog
  // ===========================================================================
  test('[LOG-01] A failed /healthCheck returns 9502 and is written to ErrorLog, not SecurityLog', { tag: '@mock-only' }, async () => {
    const res = await client.send('/healthCheck', { simulateFailure: true });
    expect(res.statusCode).toBe(400);
    expect(res.response.errorInfo.code).toBe(9502);
    const state = await inspectMockState();
    const entry = state.errorLogs.find((l: any) => l.correlationId === res.correlationID);
    expect(entry).toBeTruthy();
    expect(entry.actionPerformed).toBe('/healthCheck');
    expect(entry.errorCode).toBe('9502');
    expect(state.securityLogs.some((l: any) => l.correlationId === res.correlationID)).toBe(false);
  });

  test('[LOG-02] Every successful non-health call is written to SecurityLog with the mandated fields', { tag: '@mock-only' }, async () => {
    const res = await client.send('/userinfo', { employeeId: 'rt00001' });
    const state = await inspectMockState();
    const entry = state.securityLogs.find((l: any) => l.correlationId === res.correlationID);
    expect(entry).toBeTruthy();
    expect(entry.actionPerformed).toBe('/userinfo');
    expect(entry.appId).toBe('StoreOS');
    expect(entry.employeeId).toBe('rt00001');
    expect(entry.storeId).toBeTruthy();
    expect(entry.machineId).toBeTruthy();
    expect(entry.logTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof entry.timeTakenMs).toBe('number');
    expect(entry.actionResult).toBe('statusCode:200//actionCode:900');
  });

  test('[LOG-03] A failed API call is logged in ErrorLog with errorCode, errorMessage, correlationId and timeTakenMs', { tag: '@mock-only' }, async () => {
    const reg = await client.send('/register/barcode', { employeeId: 'rt00001', pin: '4354', validity: 300 });
    const bad = await client.send('/authenticate/barcode', {
      barcodeData: reg.response.barcodeData,
      pin: '0000',
    });
    expect(bad.response.errorInfo.code).toBe(6523);
    const state = await inspectMockState();
    const entry = state.errorLogs.find((l: any) => l.correlationId === bad.correlationID);
    expect(entry).toBeTruthy();
    expect(entry.actionPerformed).toBe('/authenticate/barcode');
    expect(entry.errorCode).toBe('6523');
    expect(entry.errorMessage).toBe('Passcode mismatch');
    expect(entry.employeeId).toBe('rt00001');
    expect(entry.errorTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof entry.timeTakenMs).toBe('number');
  });

  test('[LOG-04] A failed non-health call is also recorded in SecurityLog with its failing statusCode/actionCode', { tag: '@mock-only' }, async () => {
    const bad = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'WrongPassword!',
    });
    const state = await inspectMockState();
    const entry = state.securityLogs.find((l: any) => l.correlationId === bad.correlationID);
    expect(entry).toBeTruthy();
    expect(entry.actionResult).toBe('statusCode:400//actionCode:651');
  });

  test('[LOG-05] Plaintext passwords never appear in responses or in the logs', { tag: '@mock-only' }, async () => {
    const password = 'SecretPassword123';
    const res = await client.send('/authenticate/credentials', { employeeId: 'rt00001', password, isLogin: true });
    expect(JSON.stringify(res)).not.toContain(password);
    await client.send('/authenticate/credentials', { employeeId: 'rt00001', password: 'WrongPassword!' });
    const state = await inspectMockState();
    const logs = JSON.stringify([state.securityLogs, state.errorLogs]);
    expect(logs).not.toContain(password);
    expect(logs).not.toContain('WrongPassword!');
  });

  test('[LOG-06] sosToken, barcode PINs, barcodes and PING/SM tokens never appear in SecurityLog or ErrorLog, on success or failure', { tag: '@mock-only' }, async () => {
    // PINs avoid every action/error code and the seeded store/machine IDs, so a match can only be a leak.
    const pin = '7319';
    const wrongPin = '2864';
    const secrets: Record<string, string> = { pin, wrongPin };
    const cids: string[] = [];
    const track = <T extends { correlationID: string }>(res: T): T => {
      cids.push(res.correlationID);
      return res;
    };

    // Temporary employee login returns an sosToken.
    const temp = track(await client.send('/authenticate/credentials', {
      employeeId: 'temp_emp_01',
      password: 'TempPassword123',
      isTempEmployee: true,
      isLogin: true,
    }));
    expect(temp.statusCode).toBe(200);
    secrets.sosToken = temp.response.sosToken;

    // Regular login returns the SM session token and the PING session.
    const login = track(await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'SecretPassword123',
      isLogin: true,
    }));
    expect(login.statusCode).toBe(200);
    secrets.smSessionToken = login.response.userInfo.sessionToken;
    secrets.pingAccessToken = login.response.userInfo.pingSession.access_token;
    secrets.pingIdToken = login.response.userInfo.pingSession.id_token;
    secrets.pingRefreshToken = login.response.userInfo.pingSession.refresh_token;

    // /user/token for a valid user and for one whose tokens are refreshed on the way.
    for (const employeeId of ['rt00001', 'expired_emp_01']) {
      const tokens = track(await client.send('/user/token', { employeeId, tokenType: ['PING', 'SM'] }));
      expect(tokens.statusCode).toBe(200);
      for (const t of tokens.response.userTokens) secrets[`${employeeId}:${t.type}`] = t.token;
    }

    // Barcode with a PIN: create, wrong PIN (failure path), then success.
    const reg = track(await client.send('/register/barcode', { employeeId: 'rt00001', pin, validity: 300 }));
    expect(reg.statusCode).toBe(200);
    secrets.barcode = reg.response.barcodeData;
    const bad = track(await client.send('/authenticate/barcode', { barcodeData: reg.response.barcodeData, pin: wrongPin }));
    expect(bad.response.errorInfo.code).toBe(6523);
    const ok = track(await client.send('/authenticate/barcode', { barcodeData: reg.response.barcodeData, pin, isLogin: true }));
    expect(ok.statusCode).toBe(200);

    // Failed temp login (ErrorLog path).
    const tempBad = track(await client.send('/authenticate/credentials', {
      employeeId: 'temp_emp_01',
      password: 'nope',
      isTempEmployee: true,
    }));
    expect(tempBad.statusCode).toBe(400);

    // Every secret was really captured, so the check below is not vacuous.
    for (const [name, value] of Object.entries(secrets)) {
      expect(typeof value, name).toBe('string');
      expect(value.length, name).toBeGreaterThanOrEqual(4);
    }

    const state = await inspectMockState();
    // Every call above was logged; the two failures also reached ErrorLog.
    for (const cid of cids) {
      expect(state.securityLogs.some((l: any) => l.correlationId === cid), cid).toBe(true);
    }
    for (const cid of [bad.correlationID, tempBad.correlationID]) {
      expect(state.errorLogs.some((l: any) => l.correlationId === cid), cid).toBe(true);
    }

    // correlationIds and timestamps contain random digits, so drop them before searching for
    // the 4-digit PINs. Compare case-insensitively: barcodes are matched case-insensitively.
    const strip = (entries: any[]) =>
      entries.map(({ correlationId, logTimestamp, errorTimestamp, ...rest }: any) => rest);
    const haystack = JSON.stringify([strip(state.securityLogs), strip(state.errorLogs)]).toLowerCase();
    for (const [name, value] of Object.entries(secrets)) {
      expect(haystack.includes(value.toLowerCase()), `${name} leaked into the logs`).toBe(false);
    }
  });

  test('[LOG-07] A successful /healthCheck is not written to SecurityLog', { tag: '@mock-only' }, async () => {
    const res = await client.send('/healthCheck');
    expect(res.statusCode).toBe(200);
    const state = await inspectMockState();
    expect(state.securityLogs.some((l: any) => l.correlationId === res.correlationID)).toBe(false);
    expect(state.securityLogs.some((l: any) => l.actionPerformed === '/healthCheck')).toBe(false);
  });

  // ===========================================================================
  // HEALTH: /healthCheck and /healthStatusUpdate
  // ===========================================================================
  test('[HEA-01] /healthCheck reports service, camera, database and UI status', { tag: '@live' }, async () => {
    const res = await client.send('/healthCheck');
    expect(res.statusCode).toBe(200);
    expect(res.response.serviceStatus.status).toBe(0);
    expect(typeof res.response.serviceStatus.uptime).toBe('number');
    expect(res.response.cameraStatus).toMatchObject({ cameraEnabled: true });
    expect(res.response.cameraStatus.hardwareStatus).toBe(0);
    expect(res.response.databaseConnection).toBe(0);
    expect(res.response.databaseMode).toBe('DB');
    expect(res.response.uiStatus).toBe(0);
  });

  test('[HEA-02] /healthCheck reports an IDP outage (status DOWN, allServicesDown, 1515) but still returns 200', { tag: '@mock-only' }, async () => {
    await setMockState({ idpDown: true });
    const res = await client.send('/healthCheck');
    expect(res.statusCode).toBe(200);
    expect(res.idpStatus).toMatchObject({ status: 'DOWN', allServicesDown: true, statusCode: 1515 });
  });

  test('[HEA-03] /healthCheck reports uiStatus -1 when the agent runs without a graphical session', { tag: '@mock-only' }, async () => {
    await setMockState({ uiEnabled: false });
    const res = await client.send('/healthCheck');
    expect(res.statusCode).toBe(200);
    expect(res.response.uiStatus).toBe(-1);
  });

  test('[HSU-01] /healthStatusUpdate heartbeat is pushed to a connected client without a request', { tag: '@mock-only' }, async () => {
    const frame = await client.waitForFrame((f) => f.path === '/healthStatusUpdate', 4000);
    expect(frame.statusCode).toBe(200);
    expect(frame.correlationID).toBe('');
    expect(frame.response.actionResult.code).toBe(900);
    expect(frame.response.serviceStatus).toBeDefined();
    expect(frame.response.cameraStatus).toBeDefined();
    expect(frame.response.databaseMode).toBe('DB');
    expect(frame.timeTaken).toMatch(/^\d+ms$/);
  });

  test('[HSU-02] A /healthStatusUpdate reporting the camera OFF is received after the camera is turned off', { tag: '@mock-only' }, async () => {
    const frame = client.waitForFrame(
      (f) => f.path === '/healthStatusUpdate' && f.response.cameraStatus?.cameraEnabled === false,
      4000
    );
    await client.send('/notify/bio-camera', { clientId: 'pos-01', action: 'OFF' });
    expect((await frame).response.cameraStatus.cameraEnabled).toBe(false);
  });

  test('[HSU-03] A /healthStatusUpdate frame is received after internet connectivity changes', { tag: '@mock-only' }, async () => {
    const frame = client.waitForFrame((f) => f.path === '/healthStatusUpdate', 4000);
    await setMockState({ offlineMode: true });
    expect((await frame).statusCode).toBe(200);
  });

  // ===========================================================================
  // /register/biometric
  // ===========================================================================
  test('[RGB-01] Biometric enrollment succeeds with the correlationID of a successful credentials login (consentVersion/state optional)', { tag: '@live-mutating' }, async () => {
    const login = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'SecretPassword123',
      isLogin: true,
    });
    expect(login.statusCode).toBe(200);
    const withoutOptional = await client.send('/register/biometric', {
      employeeId: 'rt00001',
      loginCorrelationID: login.correlationID,
      consentGiven: true,
    });
    expect(withoutOptional.statusCode).toBe(200);
    expect(withoutOptional.response.actionResult.code).toBe(100);

    const withOptional = await client.send('/register/biometric', {
      employeeId: 'rt00001',
      loginCorrelationID: login.correlationID,
      consentGiven: true,
      consentVersion: 'v1.0',
      state: 'CA',
    });
    expect(withOptional.statusCode).toBe(200);
  });

  test('[RGB-02] Biometric enrollment is rejected with 6501 when the login correlationID belongs to a failed login', { tag: '@mock-only' }, async () => {
    const failed = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'WrongPassword!',
    });
    expect(failed.statusCode).toBe(400);
    const res = await client.send('/register/biometric', {
      employeeId: 'rt00001',
      loginCorrelationID: failed.correlationID,
    });
    expect(res.statusCode).toBe(400);
    expect(res.response.actionResult.code).toBe(152);
    expect(res.response.errorInfo.code).toBe(6501);
  });

  test('[RGB-03] Biometric enrollment rejects a loginCorrelationID that was not produced by a credentials login or temp registration', { tag: '@live' }, async () => {
    const info = await client.send('/userinfo', { employeeId: 'rt00001' });
    const res = await client.send('/register/biometric', {
      employeeId: 'rt00001',
      loginCorrelationID: info.correlationID,
    });
    expect(res.statusCode).toBe(400);
    expect(res.response.actionResult.code).toBe(152);
  });

  test('[RGB-04] Biometric enrollment returns 9500 when the UI cannot be initialized (headless)', { tag: '@mock-only' }, async () => {
    await setMockState({ uiEnabled: false });
    const res = await client.send('/register/biometric', {
      employeeId: 'rt00001',
      loginCorrelationID: 'valid-login-cid-001',
    });
    expect(res.statusCode).toBe(400);
    expect(res.response.errorInfo.code).toBe(9500);
  });

  test('[UI-01] Closing the UI (X icon) during enrollment or authentication returns 9509 "Back UI navigation"', { tag: '@mock-only' }, async () => {
    const enroll = await client.send('/register/biometric', {
      employeeId: 'rt00001',
      loginCorrelationID: 'valid-login-cid-001',
      simulateUiClose: true,
    });
    expect(enroll.statusCode).toBe(400);
    expect(enroll.response.actionResult.code).toBe(950);
    expect(enroll.response.errorInfo.code).toBe(9509);

    const auth = await client.send('/authenticate/biometric', {
      employeeId: 'rt00001',
      uiDelay: 0,
      simulateUiClose: true,
    });
    expect(auth.statusCode).toBe(400);
    expect(auth.response.errorInfo.code).toBe(9509);
    expect(auth.response.errorInfo.message).toBe('Back UI navigation');
  });

  // ===========================================================================
  // /authenticate/credentials
  // ===========================================================================
  test('[CRD-01] Credential login: isLogin=false omits credentialType/credentialRefId when nothing is stored', { tag: '@mock-only' }, async () => {
    const res = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'SecretPassword123',
      isLogin: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.response.credentialType).toBeUndefined();
    expect(res.response.credentialRefId).toBeUndefined();
    expect(typeof res.response.isBiometricRegistered).toBe('boolean');
  });

  test('[CRD-02] Credential login: isLogin=true stores credentialType/credentialRefId and a later isLogin=false returns the stored values', { tag: '@live-mutating' }, async () => {
    const first = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'SecretPassword123',
      isLogin: true,
    });
    expect(first.response.credentialType).toBe('credentials');
    expect(first.response.credentialRefId).toBe(first.correlationID);

    const second = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'SecretPassword123',
      isLogin: false,
    });
    expect(second.response.credentialType).toBe('credentials');
    expect(second.response.credentialRefId).toBe(first.correlationID);
  });

  test('[CRD-03] Temporary employee login (isTempEmployee=true) returns an sosToken and rejects a wrong password with 6501', { tag: '@mock-only' }, async () => {
    const ok = await client.send('/authenticate/credentials', {
      employeeId: 'temp_emp_01',
      password: 'TempPassword123',
      isTempEmployee: true,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.response.actionResult.code).toBe(601);
    expect(ok.response.sosToken).toBeTruthy();

    const bad = await client.send('/authenticate/credentials', {
      employeeId: 'temp_emp_01',
      password: 'nope',
      isTempEmployee: true,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.response.errorInfo.code).toBe(6501);
  });

  test('[CRD-04] Credential login for an unknown employee is rejected with 651/6501', { tag: '@live' }, async () => {
    const res = await client.send('/authenticate/credentials', {
      employeeId: 'unknown_999',
      password: 'whatever',
    });
    expect(res.statusCode).toBe(400);
    expect(res.response.actionResult.code).toBe(651);
    expect(res.response.errorInfo.code).toBe(6501);
  });

  // ===========================================================================
  // /authenticate/biometric
  // ===========================================================================
  test('[BIO-01] 1:N search without employeeId identifies the cached user and returns uuid, userInfo and modelUsed', { tag: '@mock-only' }, async () => {
    const res = await client.send('/authenticate/biometric', { uiDelay: 0, liveness_reco: true });
    expect(res.statusCode).toBe(200);
    expect(res.response.actionResult.code).toBe(102);
    expect(res.response.uuid).toBeTruthy();
    expect(res.response.userInfo.employeeId).toBe('rt00001');
    expect(res.modelUsed).toBe('mbfv1');
  });

  test('[BIO-02] A 1:1 request for an employee that is not in the cache, and a 1:N search with no match, return 1506', { tag: '@mock-only' }, async () => {
    const oneToOne = await client.send('/authenticate/biometric', { employeeId: 'unknown_999', uiDelay: 0 });
    expect(oneToOne.statusCode).toBe(400);
    expect(oneToOne.response.actionResult.code).toBe(153);
    expect(oneToOne.response.errorInfo.code).toBe(1506);

    const oneToN = await client.send('/authenticate/biometric', {
      uiDelay: 0,
      simulatedMatchedEmployeeId: 'unknown_999',
    });
    expect(oneToN.statusCode).toBe(400);
    expect(oneToN.response.errorInfo.code).toBe(1506);
  });

  test('[BIO-03] Biometric login: isLogin=true stores credentialType "biometric" with the correlationID; isLogin=false returns stored values', { tag: '@live-mutating' }, async () => {
    const first = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0, isLogin: true });
    expect(first.statusCode).toBe(200);
    expect(first.response.credentialType).toBe('biometric');
    expect(first.response.credentialRefId).toBe(first.correlationID);

    const second = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0, isLogin: false });
    expect(second.response.credentialType).toBe('biometric');
    expect(second.response.credentialRefId).toBe(first.correlationID);
  });

  test('[BIO-04] During capture the agent reports no face (1503), multiple faces (1501) and poor image quality (1502) as 150 re-scan prompts', { tag: '@mock-only' }, async () => {
    const noFace = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0, simulateNoFace: true });
    expect(noFace.statusCode).toBe(400);
    expect(noFace.response.actionResult.code).toBe(150);
    expect(noFace.response.errorInfo.code).toBe(1503);

    const multi = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0, simulateMultipleFaces: true });
    expect(multi.statusCode).toBe(400);
    expect(multi.response.actionResult.code).toBe(150);
    expect(multi.response.errorInfo.code).toBe(1501);

    const poor = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0, simulateVisionCode: 'Too blurry' });
    expect(poor.response.actionResult.code).toBe(150);
    expect(poor.response.errorInfo.code).toBe(1502);
  });

  const visionTable: Array<[string, string]> = [
    ['Too close', 'Move back'],
    ['Too far', 'Move closer'],
    ['Close to right edge', 'Center your head in the frame'],
    ['Close to left edge', 'Center your head in the frame'],
    ['Close to top edge', 'Center your head in the frame'],
    ['Close to bottom edge', 'Center your head in the frame'],
    ['Too blurry', 'Hold Still'],
    ['Eyeglasses detected', 'Remove glasses'],
    ['Facemask detected', 'Remove mask'],
    ['Chin too far left', 'Look at the camera'],
    ['Chin too far right', 'Look at the camera'],
    ['Chin too far up / Point camera at face', 'Look at the camera'],
    ['Chin too far down / Point camera at face', 'Look at the camera'],
    ['Image too dim', 'Too dim - increase lighting'],
    ['Image too bright', 'Too bright - lower lighting'],
    ['Face low confidence value', 'Center your head in the frame'],
    ['Eyes closed', 'Hold still'],
    ['Mouth open', 'Close mouth'],
    ['Face tilted right', 'Straighten head'],
    ['Face tilted left', 'Straighten head'],
  ];
  for (const [vision, message] of visionTable) {
    test(`[UIG-01] CVS feedback translation: "${vision}" -> "${message}"`, { tag: '@mock-only' }, async () => {
      const res = await client.send('/authenticate/biometric', {
        employeeId: 'rt00001',
        uiDelay: 0,
        simulateVisionCode: vision,
      });
      expect(res.response.errorInfo.code).toBe(1502);
      expect(res.response.errorInfo.uiGuidance).toBe(message);
    });
  }

  test('[BIO-05] The 30-second capture timeout is reported as actionResult 153 with errorInfo 1504', { tag: '@mock-only' }, async () => {
    const res = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0, simulateTimeout: true });
    expect(res.response.actionResult.code).toBe(153);
    expect(res.response.errorInfo.code).toBe(1504);
  });

  test('[BIO-06] Passive 1:1 authentication that completes inside the delay window sends no interim 1500 frame', { tag: '@mock-only' }, async () => {
    const frames = await client.sendAndCollectAll('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 2.5 });
    expect(frames).toHaveLength(1);
    expect(frames[0].statusCode).toBe(200);
  });

  test('[BIO-07] Expired token with the IDP reachable returns 153/1509 plus userInfo', { tag: '@mock-only' }, async () => {
    const res = await client.send('/authenticate/biometric', { employeeId: 'expired_emp_01', uiDelay: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.response.actionResult.code).toBe(153);
    expect(res.response.errorInfo.code).toBe(1509);
    expect(res.response.userInfo.employeeId).toBe('expired_emp_01');
    expect(res.modelUsed).toBe('mbfv1');
  });

  test('[BIO-08] Expired token while the IDP is down returns 153/1510 plus cached userInfo', { tag: '@mock-only' }, async () => {
    await setMockState({ idpDown: true });
    const res = await client.send('/authenticate/biometric', { employeeId: 'expired_emp_01', uiDelay: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.response.actionResult.code).toBe(153);
    expect(res.response.errorInfo.code).toBe(1510);
    expect(res.response.userInfo.employeeId).toBe('expired_emp_01');
  });

  test('[BIO-09] A cached user with neither a SiteMinder nor a PING token returns 1510 plus cached userInfo', { tag: '@mock-only' }, async () => {
    const res = await client.send('/authenticate/biometric', { employeeId: 'notoken_emp_01', uiDelay: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.response.errorInfo.code).toBe(1510);
    expect(res.response.userInfo.employeeId).toBe('notoken_emp_01');
  });

  test('[OFF-01] Offline: 1:1 and 1:N biometric authentication succeed from the local cache while tokens are valid', { tag: '@mock-only' }, async () => {
    await setMockState({ offlineMode: true });
    const oneToOne = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0 });
    expect(oneToOne.statusCode).toBe(200);
    expect(oneToOne.response.actionResult.code).toBe(102);
    const oneToN = await client.send('/authenticate/biometric', { uiDelay: 0 });
    expect(oneToN.statusCode).toBe(200);
  });

  test('[OFF-02] Offline: an expired token returns 1510 with cached userInfo; unknown user returns 1506; face mismatch returns 1505', { tag: '@mock-only' }, async () => {
    await setMockState({ offlineMode: true });
    const expired = await client.send('/authenticate/biometric', { employeeId: 'expired_emp_01', uiDelay: 0 });
    expect(expired.response.errorInfo.code).toBe(1510);
    expect(expired.response.userInfo.employeeId).toBe('expired_emp_01');

    const unknown = await client.send('/authenticate/biometric', { employeeId: 'unknown_999', uiDelay: 0 });
    expect(unknown.response.errorInfo.code).toBe(1506);

    const mismatch = await client.send('/authenticate/biometric', {
      employeeId: 'rt00001',
      uiDelay: 0,
      simulateFaceMismatch: true,
    });
    expect(mismatch.response.errorInfo.code).toBe(1505);
  });

  test('[OFF-03] Offline: audit logs are queued locally as pending and are synced once connectivity returns and logs are uploaded', { tag: '@mock-only' }, async () => {
    await setMockState({ offlineMode: true });
    const res = await client.send('/userinfo', { employeeId: 'rt00001' });
    let state = await inspectMockState();
    expect(state.securityLogs.find((l: any) => l.correlationId === res.correlationID).synced).toBe(false);

    await setMockState({ offlineMode: false });
    const upload = await client.send('/uploadLogs', { logType: 'all' });
    expect(upload.statusCode).toBe(200);
    state = await inspectMockState();
    expect(state.securityLogs.every((l: any) => l.synced === true)).toBe(true);
  });

  // ===========================================================================
  // DB failure -> Memory mode
  // ===========================================================================
  test('[DBF-01] After a database failure the agent stays up in Memory mode and keeps serving other requests', { tag: '@mock-only' }, async () => {
    const fail = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0, simulateDbError: true });
    expect(fail.statusCode).toBe(400);
    expect(fail.response.actionResult.code).toBe(950);
    expect(fail.response.errorInfo.code).toBe(9524);

    const hc = await client.send('/healthCheck');
    expect(hc.statusCode).toBe(200);
    expect(hc.response.databaseMode).toBe('Memory');
    const cred = await client.send('/authenticate/credentials', { employeeId: 'rt00001', password: 'SecretPassword123' });
    expect(cred.statusCode).toBe(200);
    const bio = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0 });
    expect(bio.statusCode).toBe(200);
  });

  // ===========================================================================
  // DIGITAL TWIN
  // ===========================================================================
  test('[TWN-01] 1:N: a single non-twin match authenticates, a single twin match or multiple matches require secondary verification (1512)', { tag: '@mock-only' }, async () => {
    const nonTwin = await client.send('/authenticate/biometric', { uiDelay: 0, simulatedMatchedEmployeeId: 'rt00001' });
    expect(nonTwin.statusCode).toBe(200);

    const twin = await client.send('/authenticate/biometric', { uiDelay: 0, simulatedMatchedEmployeeId: 'twin_emp_01' });
    expect(twin.response.errorInfo.code).toBe(1512);
    expect(twin.response.actionResult.code).toBe(153);

    const ambiguous = await client.send('/authenticate/biometric', { uiDelay: 0, simulateAmbiguousMatch: true });
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.response.errorInfo.code).toBe(1512);
  });

  test('[TWN-02] 1:1: a face mismatch returns 1505 even for a twin; a non-twin 1:1 match never asks for secondary verification', { tag: '@mock-only' }, async () => {
    const mismatch = await client.send('/authenticate/biometric', {
      employeeId: 'twin_emp_01',
      uiDelay: 0,
      simulateFaceMismatch: true,
    });
    expect(mismatch.response.errorInfo.code).toBe(1505);

    const nonTwin = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0 });
    expect(nonTwin.statusCode).toBe(200);
  });

  test('[TWN-03] 1:1 twin: periodic_interval_minutes = 0 always requires secondary verification, even right after a credential login', { tag: '@mock-only' }, async () => {
    await setMockState({ periodicIntervalMinutes: 0 });
    await client.send('/authenticate/credentials', { employeeId: 'twin_emp_01', password: 'TwinPassword123' });
    const res = await client.send('/authenticate/biometric', { employeeId: 'twin_emp_01', uiDelay: 0 });
    expect(res.response.errorInfo.code).toBe(1512);
  });

  test('[TWN-04] 1:1 twin: secondary verification is valid only inside the interval and a successful biometric does not extend it', { tag: '@mock-only' }, async () => {
    await setMockState({ periodicIntervalMinutes: 0.01 }); // 600 ms window from the credential login
    const cred = await client.send('/authenticate/credentials', { employeeId: 'twin_emp_01', password: 'TwinPassword123' });
    expect(cred.statusCode).toBe(200);
    // Biometric success late in the window (~350 ms). If it extended the window, the next
    // call (~750 ms) would still be inside it (until ~950 ms) and return 200.
    await sleep(350);
    const inside = await client.send('/authenticate/biometric', { employeeId: 'twin_emp_01', uiDelay: 0 });
    expect(inside.statusCode).toBe(200);
    await sleep(400);
    const outside = await client.send('/authenticate/biometric', { employeeId: 'twin_emp_01', uiDelay: 0 });
    expect(outside.response.errorInfo.code).toBe(1512);
  });

  test('[TWN-05] 1:1 twin: a never-authenticated twin (no last_authenticated_at) requires a challenge', { tag: '@mock-only' }, async () => {
    const res = await client.send('/authenticate/biometric', { employeeId: 'twin_emp_01', uiDelay: 0 });
    expect(res.response.errorInfo.code).toBe(1512);
  });

  test('[TWN-06] Secondary verification by barcode, or by /userinfo with assignStore=true, clears the 1512 challenge', { tag: '@mock-only' }, async () => {
    // via barcode
    const reg = await client.send('/register/barcode', { employeeId: 'twin_emp_01', pin: '1111', validity: 300 });
    const auth = await client.send('/authenticate/barcode', { barcodeData: reg.response.barcodeData, pin: '1111' });
    expect(auth.statusCode).toBe(200);
    const afterBarcode = await client.send('/authenticate/biometric', { employeeId: 'twin_emp_01', uiDelay: 0 });
    expect(afterBarcode.statusCode).toBe(200);

    // via userinfo assignStore (fresh state)
    await resetMockState();
    const before = await client.send('/authenticate/biometric', { employeeId: 'twin_emp_01', uiDelay: 0 });
    expect(before.response.errorInfo.code).toBe(1512);
    await client.send('/userinfo', { employeeId: 'twin_emp_01', assignStore: true });
    const afterUserinfo = await client.send('/authenticate/biometric', { employeeId: 'twin_emp_01', uiDelay: 0 });
    expect(afterUserinfo.statusCode).toBe(200);
  });

  // ===========================================================================
  // /register/barcode and /authenticate/barcode
  // ===========================================================================
  test('[BAR-01] Barcode creation returns code 602 with barcodeData and the owner first/middle/last name (empty strings when unknown)', { tag: '@live-mutating' }, async () => {
    const res = await client.send('/register/barcode', { employeeId: 'rt00001', pin: '4354', validity: 300 });
    expect(res.statusCode).toBe(200);
    expect(res.response.actionResult.code).toBe(602);
    expect(typeof res.response.firstName).toBe('string');
    expect(typeof res.response.middleName).toBe('string');
    expect(typeof res.response.lastName).toBe('string');
    expect(res.response.firstName).toBe('Amina-Louise');
  });

  test('[BAR-02] Barcode creation without employeeId or validity returns 652/9510', { tag: '@live' }, async () => {
    const noEmployee = await client.send('/register/barcode', { pin: '4354', validity: 300 });
    expect(noEmployee.statusCode).toBe(400);
    expect(noEmployee.response.actionResult.code).toBe(652);
    expect(noEmployee.response.errorInfo.code).toBe(9510);
    const noValidity = await client.send('/register/barcode', { employeeId: 'rt00001', pin: '4354' });
    expect(noValidity.response.errorInfo.code).toBe(9510);
  });

  test('[BAR-03] FallBackAuthWithPinEnabled=N makes the PIN optional; =Y makes it mandatory for creation', { tag: '@mock-only' }, async () => {
    const withFlagY = await client.send('/register/barcode', { employeeId: 'rt00001', validity: 300 });
    expect(withFlagY.statusCode).toBe(400);
    expect(withFlagY.response.errorInfo.code).toBe(9510);

    await client.send('/setConfiguration', { configurations: { FallBackAuthWithPinEnabled: 'N' } });
    const created = await client.send('/register/barcode', { employeeId: 'rt00001', validity: 300 });
    expect(created.statusCode).toBe(200);
    const auth = await client.send('/authenticate/barcode', { barcodeData: created.response.barcodeData });
    expect(auth.statusCode).toBe(200);
    expect(auth.response.actionResult.code).toBe(603);
  });

  test('[BAR-04] Generated barcodes are 13 characters, "BI"-prefixed and unique', { tag: '@live-mutating' }, async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 15; i++) {
      const res = await client.send('/register/barcode', { employeeId: 'rt00001', pin: '4354', validity: 60 });
      expect(res.response.barcodeData).toMatch(/^BI[A-Z0-9]{11}$/);
      seen.add(res.response.barcodeData);
    }
    expect(seen.size).toBe(15);
  });

  test('[BAR-05] A barcode stops working after its validity (seconds) has elapsed, returning 653/6522', { tag: '@live-mutating' }, async () => {
    const reg = await client.send('/register/barcode', { employeeId: 'rt00001', pin: '4354', validity: 1 });
    const fresh = await client.send('/authenticate/barcode', { barcodeData: reg.response.barcodeData, pin: '4354' });
    expect(fresh.statusCode).toBe(200);
    await sleep(1300);
    const expired = await client.send('/authenticate/barcode', { barcodeData: reg.response.barcodeData, pin: '4354' });
    expect(expired.statusCode).toBe(400);
    expect(expired.response.actionResult.code).toBe(653);
    expect(expired.response.errorInfo.code).toBe(6522);
  });

  test('[BAR-06] Barcode authentication rejects a missing barcodeData (9510) and an unknown barcode (6522)', { tag: '@live' }, async () => {
    const missing = await client.send('/authenticate/barcode', { pin: '4354' });
    expect(missing.statusCode).toBe(400);
    expect(missing.response.actionResult.code).toBe(653);
    expect(missing.response.errorInfo.code).toBe(9510);

    const unknown = await client.send('/authenticate/barcode', { barcodeData: 'BIZZZZZZZZZZZ', pin: '4354' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.response.errorInfo.code).toBe(6522);
  });

  test('[BAR-07] Barcode login: isLogin=true stores credentialType "barcode" with the correlationID; employeeId in the payload is optional', { tag: '@live-mutating' }, async () => {
    const reg = await client.send('/register/barcode', { employeeId: 'rt00001', pin: '4354', validity: 300 });
    const auth = await client.send('/authenticate/barcode', {
      barcodeData: reg.response.barcodeData,
      pin: '4354',
      isLogin: true,
    });
    expect(auth.statusCode).toBe(200);
    expect(auth.response.credentialType).toBe('barcode');
    expect(auth.response.credentialRefId).toBe(auth.correlationID);
    expect(auth.response.userInfo.employeeId).toBe('rt00001');
  });

  test('[BAR-08] A temporary employee with an expired profile cannot create a barcode (6500)', { tag: '@mock-only' }, async () => {
    await registerTemp('T_EXPIRED_BC', { profileExpiryTimestamp: Math.floor(Date.now() / 1000) - 60 });
    const res = await client.send('/register/barcode', { employeeId: 'T_EXPIRED_BC', pin: '4354', validity: 300 });
    expect(res.statusCode).toBe(400);
    expect(res.response.actionResult.code).toBe(652);
    expect(res.response.errorInfo.code).toBe(6500);
  });

  // ===========================================================================
  // TEMPORARY EMPLOYEES: registration, offline use, revalidation
  // ===========================================================================
  test('[TMP-01] /register/tempEmployee with an empty or incomplete payload is rejected with 951/9510', { tag: '@live' }, async () => {
    for (const payload of [{}, { employeeId: 'T_MISSING_01', firstName: 'No' }]) {
      const res = await client.send('/register/tempEmployee', payload);
      expect(res.statusCode).toBe(400);
      expect(res.response.actionResult.code).toBe(951);
      expect(res.response.errorInfo.code).toBe(9510);
    }
  });

  test('[TMP-02] Offline temp user can use a PIN barcode locally; once IdPs are back the local profile is not served (6522)', { tag: '@mock-only' }, async () => {
    await setMockState({ offlineMode: true });
    await registerTemp('OFFLINE_TEMP_BC');
    const reg = await client.send('/register/barcode', { employeeId: 'OFFLINE_TEMP_BC', pin: '4321', validity: 300 });
    expect(reg.statusCode).toBe(200);
    const offlineAuth = await client.send('/authenticate/barcode', {
      barcodeData: reg.response.barcodeData,
      pin: '4321',
      employeeId: 'OFFLINE_TEMP_BC',
    });
    expect(offlineAuth.statusCode).toBe(200);
    expect(offlineAuth.response.actionResult.code).toBe(603);

    await setMockState({ offlineMode: false });
    const online = await client.send('/authenticate/barcode', {
      barcodeData: reg.response.barcodeData,
      pin: '4321',
      employeeId: 'OFFLINE_TEMP_BC',
    });
    expect(online.statusCode).toBe(400);
    expect(online.response.actionResult.code).toBe(653);
    expect(online.response.errorInfo.code).toBe(6522);
  });

  test('[TMP-03] Revalidation when IdPs return: profile found in the same store succeeds and replaces the offline profile', { tag: '@mock-only' }, async () => {
    await setMockState({ offlineMode: true });
    const reg = await registerTemp('REVAL_SAME_STORE');
    await client.send('/register/biometric', { employeeId: 'REVAL_SAME_STORE', loginCorrelationID: reg.correlationID });
    await setMockState({ offlineMode: false });
    const first = await client.send('/authenticate/biometric', { employeeId: 'REVAL_SAME_STORE', uiDelay: 0 });
    expect(first.statusCode).toBe(200);
    expect(first.response.actionResult.code).toBe(102);
    // Once replaced, the profile is no longer an offline one, so a revalidation failure
    // condition must no longer apply to it.
    await setMockState({ storeIdMismatchOnRevalidate: true });
    const second = await client.send('/authenticate/biometric', { employeeId: 'REVAL_SAME_STORE', uiDelay: 0 });
    expect(second.statusCode).toBe(200);
    expect(second.response.actionResult.code).toBe(102);
    expect(second.storeIdMismatch).toBeUndefined();
  });

  test('[TMP-04] Revalidation when IdPs return: profile found in another store returns 1509 with storeIdMismatch=true and is not cached', { tag: '@mock-only' }, async () => {
    await setMockState({ offlineMode: true });
    const reg = await registerTemp('REVAL_OTHER_STORE');
    await client.send('/register/biometric', { employeeId: 'REVAL_OTHER_STORE', loginCorrelationID: reg.correlationID });
    await setMockState({ offlineMode: false, storeIdMismatchOnRevalidate: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await client.send('/authenticate/biometric', { employeeId: 'REVAL_OTHER_STORE', uiDelay: 0 });
      expect(res.response.errorInfo.code).toBe(1509);
      expect(res.storeIdMismatch).toBe(true);
    }
  });

  test('[TMP-05] Revalidation when IdPs return: profile found in no store returns 1506 "User not found"', { tag: '@mock-only' }, async () => {
    await setMockState({ offlineMode: true });
    const reg = await registerTemp('REVAL_NO_STORE');
    await client.send('/register/biometric', { employeeId: 'REVAL_NO_STORE', loginCorrelationID: reg.correlationID });
    await setMockState({ offlineMode: false, profileMissingOnRevalidate: true });
    const res = await client.send('/authenticate/biometric', { employeeId: 'REVAL_NO_STORE', uiDelay: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.response.errorInfo.code).toBe(1506);
  });

  test('[TMP-06] Offline biometric enrollment is only allowed for temporary (tempRegistration) users', { tag: '@mock-only' }, async () => {
    await setMockState({ offlineMode: true });
    const res = await client.send('/register/biometric', {
      employeeId: 'rt00001',
      loginCorrelationID: 'valid-login-cid-001',
    });
    expect(res.statusCode).toBe(400);
    expect(res.response.actionResult.code).toBe(152);
  });

  // ===========================================================================
  // /terminate/transaction
  // ===========================================================================
  test('[TRM-01] Terminating one in-flight transaction cancels it silently and lets other in-flight transactions complete with 102', { tag: '@mock-only' }, async () => {
    const cancelled = `e2e-cancel-${Date.now()}`;
    const survivor = `e2e-survive-${Date.now()}`;
    const cancelledP = client
      .send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0, simulateHangMs: 1200 }, cancelled, 2500)
      .then(() => 'responded', () => 'silent');
    const survivorP = client.send(
      '/authenticate/biometric',
      { employeeId: 'rt00001', uiDelay: 0, simulateHangMs: 600 },
      survivor,
      2500
    );
    const term = await client.send('/terminate/transaction', { targetCorrelationID: cancelled });
    expect(term.statusCode).toBe(200);
    expect(term.response.actionResult.code).toBe(900);
    const result = await survivorP;
    expect(result.statusCode).toBe(200);
    expect(result.response.actionResult.code).toBe(102);
    expect(await cancelledP).toBe('silent');
  });

  // ===========================================================================
  // /userinfo
  // ===========================================================================
  test('[USR-01] /userinfo for an unknown employee returns 651/6500, with or without assignStore', { tag: '@live' }, async () => {
    for (const assignStore of [false, true]) {
      const res = await client.send('/userinfo', { employeeId: 'unknown_999', assignStore });
      expect(res.statusCode).toBe(400);
      expect(res.response.actionResult.code).toBe(651);
      expect(res.response.errorInfo.code).toBe(6500);
    }
  });

  test('[USR-02] /userinfo returns the stored credentialType and credentialRefId, and assigns store/workstation when assignStore=true', { tag: '@live-mutating' }, async () => {
    const login = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'SecretPassword123',
      isLogin: true,
    });
    const plain = await client.send('/userinfo', { employeeId: 'rt00001' });
    expect(plain.response.credentialType).toBe('credentials');
    expect(plain.response.credentialRefId).toBe(login.correlationID);

    const assigned = await client.send('/userinfo', { employeeId: 'rt00001', assignStore: true });
    expect(assigned.response.userInfo.store_id).toBeTruthy();
    expect(assigned.response.userInfo.workstation).toBeTruthy();
  });

  test('[USR-03] /userinfo without assignStore does not assign store_id or workstation', { tag: '@mock-only' }, async () => {
    // Mock-only: on a live agent the profile may already carry a store from earlier use.
    const plain = await client.send('/userinfo', { employeeId: 'rt00001' });
    expect(plain.statusCode).toBe(200);
    expect(plain.response.userInfo.store_id).toBeUndefined();
    expect(plain.response.userInfo.workstation).toBeUndefined();
  });

  // ===========================================================================
  // /forgetMe
  // ===========================================================================
  test('[FGT-01] /forgetMe for an unknown employee returns 651/6500', { tag: '@live-mutating' }, async () => {
    const res = await client.send('/forgetMe', { employeeId: 'unknown_999' });
    expect(res.statusCode).toBe(400);
    expect(res.response.actionResult.code).toBe(651);
    expect(res.response.errorInfo.code).toBe(6500);
  });

  test('[FGT-02] /forgetMe without deleteFaceId succeeds and removes the cached profile', { tag: '@live-mutating' }, async () => {
    const id = uniqueId('T_FGT');
    expect((await registerTemp(id)).statusCode).toBe(200);
    const res = await client.send('/forgetMe', { employeeId: id });
    expect(res.statusCode).toBe(200);
    const after = await client.send('/userinfo', { employeeId: id });
    expect(after.response.errorInfo.code).toBe(6500);
  });

  test('[FGT-03] If the biometric (UUID) deletion fails the agent returns 9506 and keeps the cached profile', { tag: '@mock-only' }, async () => {
    const res = await client.send('/forgetMe', { employeeId: 'rt00001', deleteFaceId: 'true', simulateDeleteFailure: true });
    expect(res.statusCode).toBe(400);
    expect(res.response.actionResult.code).toBe(950);
    expect(res.response.errorInfo.code).toBe(9506);
    const still = await client.send('/userinfo', { employeeId: 'rt00001' });
    expect(still.statusCode).toBe(200);
  });

  // ===========================================================================
  // /uploadLogs
  // ===========================================================================
  for (const logType of ['error', 'info', 'debug', 'all']) {
    test(`[UPL-01] /uploadLogs accepts logType "${logType}"`, { tag: '@live' }, async () => {
      const res = await client.send('/uploadLogs', { logType });
      expect(res.statusCode).toBe(200);
      expect(res.response.actionResult.code).toBe(900);
    });
  }

  test('[UPL-02] /uploadLogs rejects an unsupported or missing logType with 950/9500', { tag: '@live' }, async () => {
    for (const payload of [{ logType: 'verbose' }, {}]) {
      const res = await client.send('/uploadLogs', payload);
      expect(res.statusCode).toBe(400);
      expect(res.response.actionResult.code).toBe(950);
      expect(res.response.errorInfo.code).toBe(9500);
    }
  });

  // ===========================================================================
  // /setConfiguration
  // ===========================================================================
  test('[CFG-01] Changing a restart-requiring key restarts the agent once; an unchanged value or a non-critical key does not', { tag: '@mock-only' }, async () => {
    const current = (await inspectMockState()).config.backend_url;
    await client.send('/setConfiguration', { configurations: { backend_url: current } });
    expect((await inspectMockState()).restartCount).toBe(0);

    await client.send('/setConfiguration', { configurations: { FallBackAuthEnabled: 'N', BarcodeExpiryTime: 450 } });
    expect((await inspectMockState()).restartCount).toBe(0);

    await client.send('/setConfiguration', { configurations: { backend_url: 'https://api-new.example.com' } });
    expect((await inspectMockState()).restartCount).toBe(1);
    await client.send('/setConfiguration', { configurations: { backend_url: 'https://api-new.example.com' } });
    expect((await inspectMockState()).restartCount).toBe(1);
  });

  test('[CFG-02] /setConfiguration persists the supplied key/value pairs', { tag: '@mock-only' }, async () => {
    await client.send('/setConfiguration', {
      configurations: { BarcodeExpiryTime: 450, BarcodeScanMaxAttempts: 3, FallBackAuthEnabled: 'N' },
    });
    const config = (await inspectMockState()).config;
    expect(config.BarcodeExpiryTime).toBe(450);
    expect(config.BarcodeScanMaxAttempts).toBe(3);
    expect(config.FallBackAuthEnabled).toBe('N');
  });

  test('[CFG-03] /setConfiguration with a missing or empty configurations object is rejected with 950/9500', { tag: '@live' }, async () => {
    for (const payload of [{}, { configurations: {} }]) {
      const res = await client.send('/setConfiguration', payload);
      expect(res.statusCode).toBe(400);
      expect(res.response.actionResult.code).toBe(950);
      expect(res.response.errorInfo.code).toBe(9500);
    }
  });

  // ===========================================================================
  // /user/token
  // ===========================================================================
  test('[TOK-01] /user/token returns one token when one type is requested, each with createdAt and expiresIn', { tag: '@live' }, async () => {
    const res = await client.send('/user/token', { employeeId: 'rt00001', tokenType: ['PING'] });
    expect(res.statusCode).toBe(200);
    expect(res.response.actionResult.code).toBe(900);
    expect(res.response.userTokens).toHaveLength(1);
    const token = res.response.userTokens[0];
    expect(token.type).toBe('PING');
    expect(token.token).toBeTruthy();
    expect(Number.isNaN(Date.parse(token.createdAt))).toBe(false);
    expect(typeof token.expiresIn).toBe('number');
  });

  test('[TOK-02] /user/token returns only the available token (still 200) when one of the requested types is unavailable', { tag: '@mock-only' }, async () => {
    const res = await client.send('/user/token', { employeeId: 'ping_only_emp_01', tokenType: ['PING', 'SM'] });
    expect(res.statusCode).toBe(200);
    expect(res.response.userTokens).toHaveLength(1);
    expect(res.response.userTokens[0].type).toBe('PING');
  });

  test('[TOK-03] /user/token returns 400/1510 when the IDP is down', { tag: '@mock-only' }, async () => {
    await setMockState({ idpDown: true });
    const res = await client.send('/user/token', { employeeId: 'rt00001', tokenType: ['PING'] });
    expect(res.statusCode).toBe(400);
    expect(res.response.errorInfo.code).toBe(1510);
  });

  // ===========================================================================
  // /notify/bio-camera
  // ===========================================================================
  test('[CAM-01] /notify/bio-camera ON/OFF are idempotent and always report 706 success', { tag: '@mock-only' }, async () => {
    for (const action of ['OFF', 'OFF', 'ON', 'ON']) {
      const res = await client.send('/notify/bio-camera', { clientId: 'pos-01', action });
      expect(res.statusCode).toBe(200);
      expect(res.response.actionResult.code).toBe(706);
    }
    const hc = await client.send('/healthCheck');
    expect(hc.response.cameraStatus.cameraEnabled).toBe(true);
  });

  test('[CAM-02] With DisableCamera or SilentModeEnabled set, an ON request succeeds but the camera stays OFF', { tag: '@mock-only' }, async () => {
    for (const flag of ['DisableCamera', 'SilentModeEnabled']) {
      await resetMockState();
      await setMockState({ config: { [flag]: true } });
      await client.send('/notify/bio-camera', { clientId: 'pos-01', action: 'OFF' });
      const on = await client.send('/notify/bio-camera', { clientId: 'pos-01', action: 'ON' });
      expect(on.statusCode, flag).toBe(200);
      expect(on.response.actionResult.code, flag).toBe(706);
      const hc = await client.send('/healthCheck');
      expect(hc.response.cameraStatus.cameraEnabled, flag).toBe(false);
    }
  });

  test('[CAM-03] A scan with the camera OFF while a VV camera is open returns 952/9520 "Agent - Camera unavailable"', { tag: '@mock-only' }, async () => {
    await client.send('/notify/bio-camera', { clientId: 'pos-01', action: 'OFF' });
    await setMockState({ vvCameraOpen: true });
    const res = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.response.actionResult.code).toBe(952);
    expect(res.response.errorInfo.code).toBe(9520);
  });

  // ===========================================================================
  // NON-GRAPHICAL (HEADLESS) MODE
  // ===========================================================================
  test('[HDL-01] Headless: UI-dependent calls fail with 950/9500 and "UI cannot be initialized"', { tag: '@mock-only' }, async () => {
    await setMockState({ uiEnabled: false });
    const bio = await client.send('/authenticate/biometric', { employeeId: 'rt00001', uiDelay: 0 });
    expect(bio.statusCode).toBe(400);
    expect(bio.response.actionResult.code).toBe(950);
    expect(bio.response.errorInfo.code).toBe(9500);
    expect(bio.response.message).toBe('UI cannot be initialized');

    const reg = await client.send('/register/barcode', { employeeId: 'rt00001', pin: '4354', validity: 300 });
    const noPin = await client.send('/authenticate/barcode', { barcodeData: reg.response.barcodeData });
    expect(noPin.response.errorInfo.code).toBe(9500);
  });

  test('[HDL-02] Headless: /healthCheck, /terminate/transaction, /register/barcode, /authenticate/barcode (with PIN), /authenticate/credentials, /userinfo and /forgetMe keep working', { tag: '@mock-only' }, async () => {
    await setMockState({ uiEnabled: false });
    expect((await client.send('/healthCheck')).statusCode).toBe(200);
    expect((await client.send('/terminate/transaction', { targetCorrelationID: 'none' })).response.errorInfo.code).toBe(9503);
    const reg = await client.send('/register/barcode', { employeeId: 'rt00001', pin: '4354', validity: 300 });
    expect(reg.statusCode).toBe(200);
    const auth = await client.send('/authenticate/barcode', { barcodeData: reg.response.barcodeData, pin: '4354' });
    expect(auth.statusCode).toBe(200);
    expect((await client.send('/authenticate/credentials', { employeeId: 'rt00001', password: 'SecretPassword123' })).statusCode).toBe(200);
    expect((await client.send('/userinfo', { employeeId: 'rt00001' })).statusCode).toBe(200);
    expect((await client.send('/forgetMe', { employeeId: 'rt00001' })).statusCode).toBe(200);
  });
});
