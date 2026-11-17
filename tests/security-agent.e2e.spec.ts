import { test, expect } from '@playwright/test';
import {
  AgentWsClient,
  resetMockState,
  setMockState,
  inspectMockState,
  IS_MOCK,
  CAN_MUTATE,
  uniqueId,
} from './ws-client';

test.describe('Charlie StoreOS Security Agent - Full End-to-End Suite', () => {
  let client: AgentWsClient;

  test.beforeEach(async () => {
    await resetMockState();
    client = new AgentWsClient();
    await client.connect();
  });

  test.afterEach(async () => {
    await client.close();
  });

  // =========================================================================
  // 1. PROTOCOL ENVELOPE, HEALTH CHECK & AUDIT LOGGING RULES
  // =========================================================================
  test('01. /healthCheck returns 200, DB mode, camera status, and excludes success from SecurityLog', async () => {
    const res = await client.send('/healthCheck');
    expect(res.statusCode).toBe(200);
    expect(res.path).toBe('/healthCheck');
    expect(res.correlationID).toBeTruthy();
    expect(res.timeTaken).toMatch(/^\d+ms$/);
    expect(res.response.actionResult.code).toBe(900);
    expect(res.response.databaseMode).toBe('DB');
    expect(res.response.cameraStatus.cameraEnabled).toBe(true);

    if (IS_MOCK) {
      const state = await inspectMockState();
      const hcLogs = state.securityLogs.filter((l: any) => l.actionPerformed === '/healthCheck');
      expect(hcLogs.length).toBe(0);
    }
  });

  // =========================================================================
  // 2. CREDENTIAL AUTHENTICATION (/authenticate/credentials)
  // =========================================================================
  test('03. /authenticate/credentials succeeds for regular employee and returns credentialRefId = correlationID when isLogin=true', async () => {
    const res = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'SecretPassword123',
      isLogin: true,
      isTempEmployee: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.response.actionResult.code).toBe(601);
    expect(res.response.credentialType).toBe('credentials');
    expect(res.response.credentialRefId).toBe(res.correlationID);
    expect(res.response.userInfo.employeeId).toBe('rt00001');
  });

  test('04. /authenticate/credentials rejects invalid password with 6501 and missing fields with 9510', async () => {
    const badPass = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'WrongPassword!',
    });
    expect(badPass.statusCode).toBe(400);
    expect(badPass.response.errorInfo.code).toBe(6501);

    const missing = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.response.errorInfo.code).toBe(9510);
  });

  test('05. /authenticate/credentials returns 6503 when IDP is unreachable', async () => {
    test.skip(!IS_MOCK, 'Requires mock IDP fault injection');
    await setMockState({ idpDown: true });
    const res = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'SecretPassword123',
    });
    expect(res.statusCode).toBe(400);
    expect(res.response.errorInfo.code).toBe(6503);
  });

  // =========================================================================
  // 3. TEMP EMPLOYEE REGISTRATION & BIOMETRIC ENROLLMENT
  // =========================================================================
  test('06. /register/tempEmployee creates temporary profile and allows biometric enrollment with its registration correlationID', async () => {
    test.skip(!CAN_MUTATE, 'Mutates live agent data; set ALLOW_LIVE_MUTATIONS=true to run');
    const tempId = uniqueId('T0059');
    const reg = await client.send('/register/tempEmployee', {
      employeeId: tempId,
      consentGiven: true,
      firstName: 'John',
      familyName: 'Doe',
      middleName: 'M',
      dob: '1990-01-01',
      employeeRole: 'T',
      sponserId: 'rt00001',
      profileExpiryTimestamp: Math.floor(Date.now() / 1000) + 86400,
    });
    expect(reg.statusCode).toBe(200);
    expect(reg.response.actionResult.code).toBe(900);

    // Enroll biometrics using the tempEmployee registration correlationID
    const bioReg = await client.send('/register/biometric', {
      employeeId: tempId,
      loginCorrelationID: reg.correlationID,
      consentGiven: true,
      consentVersion: 'v1.0',
      state: 'MA',
    });
    expect(bioReg.statusCode).toBe(200);
    expect(bioReg.response.actionResult.code).toBe(100);
  });

  test('07. /register/biometric validates mandatory fields (9510), unknown user (6500), and invalid loginCorrelationID', async () => {
    const missing = await client.send('/register/biometric', { employeeId: 'rt00001' });
    expect(missing.statusCode).toBe(400);
    expect(missing.response.errorInfo.code).toBe(9510);

    const unknownUser = await client.send('/register/biometric', {
      employeeId: 'unknown_999',
      loginCorrelationID: 'valid-login-cid-001',
    });
    expect(unknownUser.statusCode).toBe(400);
    expect(unknownUser.response.errorInfo.code).toBe(6500);

    const badLoginCid = await client.send('/register/biometric', {
      employeeId: 'rt00001',
      loginCorrelationID: 'non-existent-login-cid',
    });
    expect(badLoginCid.statusCode).toBe(400);
    expect(badLoginCid.response.errorInfo.code).toBe(6500);
  });

  // =========================================================================
  // 4. BIOMETRIC AUTHENTICATION (1:1, 1:N, PASSIVE DELAY, GUIDANCE, DIGITAL TWIN)
  // =========================================================================
  test('08. /authenticate/biometric 1:1 active scan succeeds with modelUsed and processingMs metrics', async () => {
    const res = await client.send('/authenticate/biometric', {
      employeeId: 'rt00001',
      uiDelay: 0,
      isLogin: true,
      liveness: true,
      liveness_reco: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.response.actionResult.code).toBe(102);
    expect(res.response.credentialType).toBe('biometric');
    expect(res.modelUsed).toBe('mbfv1');
    expect(typeof res.processingMs).toBe('number');
  });

  test('09. /authenticate/biometric 1:N passive scan emits intermediate 1500 pending decision before 200 match', async () => {
    test.skip(!IS_MOCK, 'Requires deterministic passive delay simulation');
    const frames = await client.sendAndCollectAll('/authenticate/biometric', {
      uiDelay: 2.5,
      isLogin: false,
    });
    expect(frames.length).toBe(2);
    expect(frames[0].response.actionResult.code).toBe(150);
    expect(frames[0].response.errorInfo.code).toBe(1500);
    expect(frames[1].statusCode).toBe(200);
    expect(frames[1].response.actionResult.code).toBe(102);
  });

  test('10. /authenticate/biometric 1:1 face mismatch for a regular employee returns 400/1505', async () => {
    test.skip(!IS_MOCK, 'Requires vision fault injection');
    // Capture timeout is covered by [BIO-05]; guidance translation by [UIG-01].
    const mismatch = await client.send('/authenticate/biometric', {
      employeeId: 'rt00001',
      uiDelay: 0,
      simulateFaceMismatch: true,
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.response.errorInfo.code).toBe(1505);
  });

  test('11. Digital Twin detection triggers 1512 on 1:N or unverified 1:1, and clears after secondary auth', async () => {
    test.skip(!IS_MOCK, 'Requires digital twin seeded user');
    // 1:N match on a digital twin must demand secondary verification (1512)
    const oneToN = await client.send('/authenticate/biometric', {
      uiDelay: 0,
      simulatedMatchedEmployeeId: 'twin_emp_01',
    });
    expect(oneToN.statusCode).toBe(400);
    expect(oneToN.response.errorInfo.code).toBe(1512);

    // 1:1 match without prior secondary verification must also return 1512
    const oneToOneBefore = await client.send('/authenticate/biometric', {
      employeeId: 'twin_emp_01',
      uiDelay: 0,
    });
    expect(oneToOneBefore.statusCode).toBe(400);
    expect(oneToOneBefore.response.errorInfo.code).toBe(1512);

    // Complete secondary verification via credentials
    const cred = await client.send('/authenticate/credentials', {
      employeeId: 'twin_emp_01',
      password: 'TwinPassword123',
      isLogin: true,
    });
    expect(cred.statusCode).toBe(200);

    // Now 1:1 biometric succeeds within periodic_interval_minutes
    const oneToOneAfter = await client.send('/authenticate/biometric', {
      employeeId: 'twin_emp_01',
      uiDelay: 0,
    });
    expect(oneToOneAfter.statusCode).toBe(200);
    expect(oneToOneAfter.response.actionResult.code).toBe(102);
  });

  // =========================================================================
  // 5. BARCODE GENERATION & AUTHENTICATION (/register/barcode, /authenticate/barcode)
  // =========================================================================
  test('12. /register/barcode and /authenticate/barcode enforce 13-char BI prefix, PIN, case-insensitivity, and employeeId match', async () => {
    test.skip(!CAN_MUTATE, 'Mutates live agent data; set ALLOW_LIVE_MUTATIONS=true to run');
    const reg = await client.send('/register/barcode', {
      employeeId: 'rt00001',
      pin: '4354',
      validity: 600,
    });
    expect(reg.statusCode).toBe(200);
    expect(reg.response.actionResult.code).toBe(602);
    const barcode: string = reg.response.barcodeData;
    expect(barcode).toMatch(/^BI[A-Z0-9]{11}$/);
    expect(barcode.length).toBe(13);

    // Wrong PIN -> 6523
    const wrongPin = await client.send('/authenticate/barcode', {
      barcodeData: barcode,
      pin: '0000',
      employeeId: 'rt00001',
    });
    expect(wrongPin.statusCode).toBe(400);
    expect(wrongPin.response.errorInfo.code).toBe(6523);

    // Wrong employeeId -> 6524 (Oct 9, 2026 spec requirement)
    const mismatchUser = await client.send('/authenticate/barcode', {
      barcodeData: barcode,
      pin: '4354',
      employeeId: 'twin_emp_01',
    });
    expect(mismatchUser.statusCode).toBe(400);
    expect(mismatchUser.response.errorInfo.code).toBe(6524);

    // Valid scan (testing case-insensitivity via lowercase barcodeData)
    const auth = await client.send('/authenticate/barcode', {
      barcodeData: barcode.toLowerCase(),
      pin: '4354',
      employeeId: 'rt00001',
      isLogin: true,
    });
    expect(auth.statusCode).toBe(200);
    expect(auth.response.actionResult.code).toBe(603);
    expect(auth.response.credentialType).toBe('barcode');
  });

  test('13. Expired barcode returns 6522', async () => {
    test.skip(!CAN_MUTATE, 'Mutates live agent data; set ALLOW_LIVE_MUTATIONS=true to run');
    const reg = await client.send('/register/barcode', {
      employeeId: 'rt00001',
      pin: '4354',
      validity: -1, // Already expired
    });
    expect(reg.statusCode).toBe(200);
    const auth = await client.send('/authenticate/barcode', {
      barcodeData: reg.response.barcodeData,
      pin: '4354',
      employeeId: 'rt00001',
    });
    expect(auth.statusCode).toBe(400);
    expect(auth.response.errorInfo.code).toBe(6522);
  });

  // =========================================================================
  // 6. USERINFO, TOKEN REFRESH, CAMERA CONTROL, CONFIG, LOGS & FORGETME
  // =========================================================================
  test('14. /userinfo assigns store_id and workstation when assignStore=true', async () => {
    const res = await client.send('/userinfo', {
      employeeId: 'rt00001',
      assignStore: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.response.userInfo.store_id).toBeTruthy();
    expect(res.response.userInfo.workstation).toBeTruthy();
  });

  test('15. /user/token returns usable PING and SM tokens, in request order, for a user whose stored tokens have expired', async () => {
    const res = await client.send('/user/token', {
      employeeId: 'expired_emp_01',
      tokenType: ['PING', 'SM'],
    });
    expect(res.statusCode).toBe(200);
    expect(res.response.userTokens).toHaveLength(2);
    expect(res.response.userTokens[0].type).toBe('PING');
    expect(res.response.userTokens[1].type).toBe('SM');
    for (const token of res.response.userTokens) {
      expect(token.token).toBeTruthy();
      expect(token.expiresIn).toBeGreaterThan(0);
    }
  });

  test('16. /notify/bio-camera toggles the camera; a scan with the camera OFF turns it back on when no VV camera is open', async () => {
    test.skip(!IS_MOCK, 'Requires hardware toggle verification');
    const offRes = await client.send('/notify/bio-camera', {
      clientId: 'pos-01',
      action: 'OFF',
    });
    expect(offRes.statusCode).toBe(200);
    expect(offRes.response.actionResult.code).toBe(706);
    const hcOff = await client.send('/healthCheck');
    expect(hcOff.response.cameraStatus.cameraEnabled).toBe(false);

    // Spec: camera OFF + VV cameras closed -> agent turns the camera ON and proceeds with the scan
    const scanWhileOff = await client.send('/authenticate/biometric', {
      employeeId: 'rt00001',
      uiDelay: 0,
    });
    expect(scanWhileOff.statusCode).toBe(200);
    const hcAfter = await client.send('/healthCheck');
    expect(hcAfter.response.cameraStatus.cameraEnabled).toBe(true);

    const onRes = await client.send('/notify/bio-camera', {
      clientId: 'pos-01',
      action: 'ON',
    });
    expect(onRes.statusCode).toBe(200);
  });

  test('17. /setConfiguration updates flags and triggers internal self-restart on critical keys', async () => {
    test.skip(!IS_MOCK, 'Changes agent configuration (incl. backend_url); verify manually on a disposable terminal');
    const res = await client.send('/setConfiguration', {
      configurations: {
        FallBackAuthWithPinEnabled: 'N',
        backend_url: 'https://api-prod.cvsauth.com',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.response.actionResult.code).toBe(900);

    if (IS_MOCK) {
      const state = await inspectMockState();
      expect(state.restartCount).toBe(1);
    }
  });

  test('18. /terminate/transaction rejects unknown targetCorrelationID with 9503', async () => {
    const res = await client.send('/terminate/transaction', {
      targetCorrelationID: 'non-existent-tx-id',
    });
    expect(res.statusCode).toBe(400);
    expect(res.response.errorInfo.code).toBe(9503);
  });

  test('20. /forgetMe wipes a user profile from cache and subsequent lookups return 6500', async () => {
    test.skip(!CAN_MUTATE, 'Mutates live agent data; set ALLOW_LIVE_MUTATIONS=true to run');
    // Uses a throwaway temp employee so no real profile is ever deleted
    const id = uniqueId('T_FORGET');
    const reg = await client.send('/register/tempEmployee', {
      employeeId: id,
      consentGiven: true,
      firstName: 'Forget',
      familyName: 'Me',
      sponserId: 'rt00001',
    });
    expect(reg.statusCode).toBe(200);

    const del = await client.send('/forgetMe', { employeeId: id, deleteFaceId: 'true' });
    expect(del.statusCode).toBe(200);
    expect(del.response.actionResult.code).toBe(900);

    const after = await client.send('/userinfo', { employeeId: id });
    expect(after.statusCode).toBe(400);
    expect(after.response.errorInfo.code).toBe(6500);
  });

  // =========================================================================
  // 7. OFFLINE TEMP REGISTRATION & REVALIDATION
  //    (headless mode: HDL-01/HDL-02; DB->Memory fallback: DBF-01 in spec-coverage)
  // =========================================================================
  test('23. Offline temporary registration & online storeIdMismatch revalidation', async () => {
    test.skip(!IS_MOCK, 'Requires offline mode toggle');
    await setMockState({ offlineMode: true });

    const tempReg = await client.send('/register/tempEmployee', {
      employeeId: 'OFFLINE_TEMP_01',
      consentGiven: true,
      firstName: 'Offline',
      familyName: 'Associate',
      sponserId: 'rt00001',
    });
    expect(tempReg.statusCode).toBe(200);

    const bioEnroll = await client.send('/register/biometric', {
      employeeId: 'OFFLINE_TEMP_01',
      loginCorrelationID: tempReg.correlationID,
    });
    expect(bioEnroll.statusCode).toBe(200);

    // Offline biometric auth succeeds
    const offlineAuth = await client.send('/authenticate/biometric', {
      employeeId: 'OFFLINE_TEMP_01',
      uiDelay: 0,
    });
    expect(offlineAuth.statusCode).toBe(200);

    // Reconnect online with store mismatch -> returns 1509 + storeIdMismatch: true
    await setMockState({ offlineMode: false, storeIdMismatchOnRevalidate: true });
    const onlineReval = await client.send('/authenticate/biometric', {
      employeeId: 'OFFLINE_TEMP_01',
      uiDelay: 0,
    });
    expect(onlineReval.response.errorInfo.code).toBe(1509);
    expect(onlineReval.storeIdMismatch).toBe(true);
  });

  // =========================================================================
  // 8. NEGATIVE-PATH COVERAGE
  // =========================================================================
  const registerTemp = (employeeId: string) =>
    client.send('/register/tempEmployee', {
      employeeId,
      consentGiven: true,
      firstName: 'Temp',
      familyName: 'User',
      sponserId: 'rt00001',
    });

  test('25. /register/tempEmployee rejects an already-existing employee with 1511', async () => {
    test.skip(!CAN_MUTATE, 'Mutates live agent data; set ALLOW_LIVE_MUTATIONS=true to run');
    const dupId = uniqueId('T_DUP');
    const first = await registerTemp(dupId);
    expect(first.statusCode).toBe(200);
    const second = await registerTemp(dupId);
    expect(second.statusCode).toBe(400);
    expect(second.response.errorInfo.code).toBe(1511);
  });

  test('26. /register/biometric surfaces vision (1502) and duplicate (1511) enrollment failures', async () => {
    test.skip(!IS_MOCK, 'Requires enrollment fault injection');
    const reg = await registerTemp('T_ENROLL_01');
    expect(reg.statusCode).toBe(200);

    const vision = await client.send('/register/biometric', {
      employeeId: 'T_ENROLL_01',
      loginCorrelationID: reg.correlationID,
      simulateVisionError: true,
    });
    expect(vision.statusCode).toBe(400);
    expect(vision.response.errorInfo.code).toBe(1502);

    const duplicate = await client.send('/register/biometric', {
      employeeId: 'T_ENROLL_01',
      loginCorrelationID: reg.correlationID,
      simulateDuplicateTemp: true,
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.response.errorInfo.code).toBe(1511);
  });

  test('27. /register/barcode rejects malformed PIN (9510) and unknown employee (6500)', async () => {
    const badPin = await client.send('/register/barcode', { employeeId: 'rt00001', pin: '12ab', validity: 300 });
    expect(badPin.statusCode).toBe(400);
    expect(badPin.response.errorInfo.code).toBe(9510);

    const unknown = await client.send('/register/barcode', { employeeId: 'unknown_999', pin: '4354', validity: 300 });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.response.errorInfo.code).toBe(6500);
  });

  test('28. /notify/bio-camera rejects an invalid action with 9510', async () => {
    const res = await client.send('/notify/bio-camera', { clientId: 'pos-01', action: 'TOGGLE' });
    expect(res.statusCode).toBe(400);
    expect(res.response.errorInfo.code).toBe(9510);
  });

  test('30. Successful logins are written to SecurityLog with statusCode 200 (audit trail)', async () => {
    test.skip(!IS_MOCK, 'Requires mock state inspection');
    const res = await client.send('/authenticate/credentials', {
      employeeId: 'rt00001',
      password: 'SecretPassword123',
      isLogin: true,
    });
    expect(res.statusCode).toBe(200);
    const state = await inspectMockState();
    const entry = state.securityLogs.find((l: any) => l.correlationId === res.correlationID);
    expect(entry).toBeTruthy();
    expect(entry.statusCode).toBe(200);
    expect(entry.actionPerformed).toBe('/authenticate/credentials');
  });

  // =========================================================================
  // 9. TOKENS, TEMP PROFILES & SPONSOR LOGIN
  //    (in-flight transactions: TRM-01 in spec-coverage)
  // =========================================================================
  test('34. /user/token validates input (9510), unknown user (6500) and IDP outage (1510)', async () => {
    const missing = await client.send('/user/token', {});
    expect(missing.statusCode).toBe(400);
    expect(missing.response.errorInfo.code).toBe(9510);

    const unknown = await client.send('/user/token', { employeeId: 'unknown_999', tokenType: ['PING'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.response.errorInfo.code).toBe(6500);

    test.skip(!IS_MOCK, 'IDP outage requires fault injection');
    await setMockState({ idpDown: true });
    const idpDown = await client.send('/user/token', { employeeId: 'rt00001', tokenType: ['PING'] });
    expect(idpDown.statusCode).toBe(400);
    expect(idpDown.response.errorInfo.code).toBe(1510);
  });

  test('35. Temp employee with a valid profile authenticates biometrically after enrollment', async () => {
    test.skip(!CAN_MUTATE, 'Mutates live agent data; set ALLOW_LIVE_MUTATIONS=true to run');
    const validId = uniqueId('T_VALID');
    const reg = await client.send('/register/tempEmployee', {
      employeeId: validId,
      consentGiven: true,
      firstName: 'Valid',
      familyName: 'Profile',
      sponserId: 'rt00001',
      profileExpiryTimestamp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(reg.statusCode).toBe(200);
    const enroll = await client.send('/register/biometric', {
      employeeId: validId,
      loginCorrelationID: reg.correlationID,
    });
    expect(enroll.statusCode).toBe(200);
    const auth = await client.send('/authenticate/biometric', { employeeId: validId, uiDelay: 0 });
    expect(auth.statusCode).toBe(200);
    expect(auth.response.actionResult.code).toBe(102);
  });

  test('36. Temp employee with an expired profile is rejected with 1506', async () => {
    test.skip(!IS_MOCK, 'Requires an already-expired profile');
    const reg = await client.send('/register/tempEmployee', {
      employeeId: 'T_EXPIRED_01',
      consentGiven: true,
      firstName: 'Expired',
      familyName: 'Profile',
      sponserId: 'rt00001',
      profileExpiryTimestamp: Math.floor(Date.now() / 1000) - 60,
    });
    expect(reg.statusCode).toBe(200);
    const enroll = await client.send('/register/biometric', {
      employeeId: 'T_EXPIRED_01',
      loginCorrelationID: reg.correlationID,
    });
    expect(enroll.statusCode).toBe(200);
    const auth = await client.send('/authenticate/biometric', { employeeId: 'T_EXPIRED_01', uiDelay: 0 });
    expect(auth.statusCode).toBe(400);
    expect(auth.response.errorInfo.code).toBe(1506);
  });

  test('37. Temp employee credential login returns sponsorId only when isLogin=true', async () => {
    test.skip(!IS_MOCK, 'Requires seeded temp employee with credentials');
    const login = await client.send('/authenticate/credentials', {
      employeeId: 'temp_emp_01',
      password: 'TempPassword123',
      isLogin: true,
      isTempEmployee: true,
    });
    expect(login.statusCode).toBe(200);
    expect(login.response.userInfo.sponsorId).toBe('rt00001');

    const check = await client.send('/authenticate/credentials', {
      employeeId: 'temp_emp_01',
      password: 'TempPassword123',
      isLogin: false,
      isTempEmployee: true,
    });
    expect(check.statusCode).toBe(200);
    expect(check.response.userInfo.sponsorId).toBeUndefined();
  });
});
