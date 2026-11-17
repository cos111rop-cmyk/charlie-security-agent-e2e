import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';

const PORT = Number(process.env.PORT || 8080);

// In-memory state simulating StoreOS Agent DB/Cache/Config/Hardware
interface UserRecord {
  employeeId: string;
  password?: string;
  firstName: string;
  middleName?: string;
  lastName: string;
  isBiometricRegistered: boolean;
  uuid?: string;
  guid?: string;
  digital_twin_status: 'twin' | 'clear' | 'unknown';
  digital_twin_pairs: string[];
  last_twin_check_at: string | null;
  last_authenticated_at?: string | null;
  isTempEmployee?: boolean;
  tempRegistration?: boolean;
  sponserId?: string;
  profileExpiryTimestamp?: number;
  credentialType?: string;
  credentialRefId?: string;
  store_id?: string;
  workstation?: string;
  sessionToken?: string;
  isSMTokenExpired?: boolean;
  pingSession?: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
  firstLogin: number;
  lastRefresh: number;
}

interface BarcodeRecord {
  barcodeData: string;
  employeeId: string;
  pin?: string;
  expiresAt: number;
  createdAt: number;
}

const state = {
  databaseMode: 'DB' as 'DB' | 'Memory',
  cameraEnabled: true,
  uiEnabled: true, // false = non-graphical / headless mode
  idpDown: false,
  allServicesDown: false,
  offlineMode: false,
  storeIdMismatchOnRevalidate: false,
  profileMissingOnRevalidate: false,
  vvCameraOpen: false,
  periodicIntervalMinutes: 60,
  config: {
    BiometricRegistrationFacialScanMaxAttempts: 5,
    AuthenticationFacialScanTimeout: 30,
    AuthenticationFacialScanMaxAttempts: 5,
    FallBackAuthEnabled: 'Y',
    FallBackAuthWithPinEnabled: 'Y',
    BarcodeExpiryTime: 300,
    BarcodeScanMaxAttempts: 5,
    DisableUserSync: false,
    SilentModeEnabled: false,
    DisableCamera: false,
    store_id: '68628',
    workstation_id: 'WS001',
    backend_url: 'https://api-develv3.cvsauth.com',
  } as Record<string, any>,
  users: new Map<string, UserRecord>(),
  barcodes: new Map<string, BarcodeRecord>(),
  securityLogs: [] as any[],
  errorLogs: [] as any[],
  activeTransactions: new Map<string, { cancelled: boolean }>(),
  restartCount: 0,
};

function seedInitialData() {
  state.users.clear();
  state.barcodes.clear();
  state.securityLogs = [];
  state.errorLogs = [];
  state.databaseMode = 'DB';
  state.restartCount = 0;
  state.cameraEnabled = true;
  state.uiEnabled = true;
  state.idpDown = false;
  state.allServicesDown = false;
  state.offlineMode = false;
  state.storeIdMismatchOnRevalidate = false;
  state.profileMissingOnRevalidate = false;
  state.vvCameraOpen = false;
  state.periodicIntervalMinutes = 60;
  state.config.FallBackAuthWithPinEnabled = 'Y';
  state.config.DisableCamera = false;
  state.config.SilentModeEnabled = false;

  const now = Date.now();
  // Regular employee
  state.users.set('rt00001', {
    employeeId: 'rt00001',
    password: 'SecretPassword123',
    firstName: 'Amina-Louise',
    middleName: 'M',
    lastName: 'Jeu',
    isBiometricRegistered: true,
    uuid: '37c233bf-1b43-43bc-87ec-68713f4b08b0',
    guid: 'ZjN9L0gI-q132-YRYJ-Lkg6-pZhJBQFs8gu6',
    digital_twin_status: 'clear',
    digital_twin_pairs: [],
    last_twin_check_at: null,
    sessionToken: 'SIAXIPI3X/validSessionToken',
    pingSession: {
      id_token: 'mock.id.token',
      access_token: 'mock.access.token',
      refresh_token: 'mock.refresh.token',
      expires_at: now + 3600_000,
    },
    firstLogin: now - 10000,
    lastRefresh: now - 5000,
  });

  // Digital twin employee
  state.users.set('twin_emp_01', {
    employeeId: 'twin_emp_01',
    password: 'TwinPassword123',
    firstName: 'Alex',
    lastName: 'Mercer',
    isBiometricRegistered: true,
    uuid: 'twin-uuid-0001',
    digital_twin_status: 'twin',
    digital_twin_pairs: ['twin_emp_02'],
    last_twin_check_at: '2026-06-03T02:00:00Z',
    last_authenticated_at: null,
    sessionToken: 'SIAXIPI3X/twinSessionToken',
    pingSession: {
      id_token: 'twin.id.token',
      access_token: 'twin.access.token',
      refresh_token: 'twin.refresh.token',
      expires_at: now + 3600_000,
    },
    firstLogin: now - 10000,
    lastRefresh: now - 5000,
  });

  // User with expired tokens
  state.users.set('expired_emp_01', {
    employeeId: 'expired_emp_01',
    password: 'ValidPassword123',
    firstName: 'Jordan',
    lastName: 'Taylor',
    isBiometricRegistered: true,
    uuid: 'exp-uuid-0001',
    digital_twin_status: 'clear',
    digital_twin_pairs: [],
    last_twin_check_at: null,
    sessionToken: 'SIAXIPI3X/expiredSessionToken',
    isSMTokenExpired: true,
    pingSession: {
      id_token: 'exp.id.token',
      access_token: 'exp.access.token',
      refresh_token: 'expired.refresh.token',
      expires_at: now - 60_000,
    },
    firstLogin: now - 7200_000,
    lastRefresh: now - 7200_000,
  });

  // Employee with no tokens at all (both IDPs unavailable when last synced)
  state.users.set('notoken_emp_01', {
    employeeId: 'notoken_emp_01',
    password: 'NoTokenPassword123',
    firstName: 'Sam',
    lastName: 'Notoken',
    isBiometricRegistered: true,
    uuid: 'notoken-uuid-0001',
    digital_twin_status: 'clear',
    digital_twin_pairs: [],
    last_twin_check_at: null,
    firstLogin: now - 10000,
    lastRefresh: now - 5000,
  });

  // Employee with only a PING session (no SiteMinder token) for partial /user/token responses
  state.users.set('ping_only_emp_01', {
    employeeId: 'ping_only_emp_01',
    password: 'PingOnlyPassword123',
    firstName: 'Pat',
    lastName: 'Pingonly',
    isBiometricRegistered: true,
    uuid: 'pingonly-uuid-0001',
    digital_twin_status: 'clear',
    digital_twin_pairs: [],
    last_twin_check_at: null,
    pingSession: {
      id_token: 'po.id.token',
      access_token: 'po.access.token',
      refresh_token: 'po.refresh.token',
      expires_at: now + 3600_000,
    },
    firstLogin: now - 10000,
    lastRefresh: now - 5000,
  });

  // Temporary employee that can log in with credentials (exercises sponsorId in userInfo)
  state.users.set('temp_emp_01', {
    employeeId: 'temp_emp_01',
    password: 'TempPassword123',
    firstName: 'Taylor',
    lastName: 'Temp',
    isBiometricRegistered: true,
    uuid: 'temp-uuid-0001',
    digital_twin_status: 'clear',
    digital_twin_pairs: [],
    last_twin_check_at: null,
    isTempEmployee: true,
    sponserId: 'rt00001',
    profileExpiryTimestamp: now + 86400_000,
    firstLogin: now - 10000,
    lastRefresh: now - 5000,
  });

  // Pre-seed a successful login correlationID for /register/biometric tests
  state.securityLogs.push({
    correlationId: 'valid-login-cid-001',
    actionPerformed: '/authenticate/credentials',
    statusCode: 200,
    employeeId: 'rt00001',
    timeTakenMs: 120,
  });
}

seedInitialData();

function healthPayload() {
  return {
    actionResult: { code: 900, message: 'Operation Success' },
    serviceStatus: { status: 0, uptime: Math.floor(process.uptime()) },
    cameraStatus: { hardwareStatus: state.cameraEnabled ? 0 : -1, cameraEnabled: state.cameraEnabled },
    databaseConnection: 0,
    databaseMode: state.databaseMode,
    uiStatus: state.uiEnabled ? 0 : -1,
  };
}

const clients = new Set<WebSocket>();
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 60_000);

function sendHealthStatusUpdate(ws: WebSocket) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    statusCode: 200,
    correlationID: '',
    path: '/healthStatusUpdate',
    response: healthPayload(),
    timeTaken: '1ms',
    processingMs: 1,
  }));
}

function broadcastHealthStatusUpdate() {
  clients.forEach(sendHealthStatusUpdate);
}

function envelope(
  statusCode: number,
  correlationID: string,
  path: string,
  response: Record<string, any>,
  startMs: number,
  extraRoot: Record<string, any> = {}
) {
  const elapsed = Math.max(1, Date.now() - startMs);
  return {
    statusCode,
    correlationID,
    path,
    response,
    timeTaken: `${elapsed}ms`,
    processingMs: elapsed,
    ...extraRoot,
  };
}

function logAudit(
  statusCode: number,
  correlationID: string,
  path: string,
  employeeId = '',
  errorCode = '',
  errorMessage = '',
  timeTakenMs = 10,
  actionCode: number | string = ''
) {
  if (path === '/healthCheck' && statusCode === 200) {
    // Spec: Successful healthCheck calls are excluded from SecurityLog
    return;
  }
  const actionResult = `statusCode:${statusCode}//actionCode:${actionCode}`;
  // Spec: all API calls are logged in SecurityLog except successful /healthCheck;
  // a failed /healthCheck goes to ErrorLog instead of SecurityLog.
  if (!(path === '/healthCheck' && statusCode !== 200)) {
    state.securityLogs.push({
      correlationId: correlationID,
      actionPerformed: path,
      actionResult,
      statusCode,
      appId: 'StoreOS',
      employeeId,
      storeId: state.config.store_id,
      machineId: state.config.workstation_id,
      logTimestamp: new Date().toISOString(),
      timeTakenMs,
      synced: !state.offlineMode,
    });
  }
  if (statusCode !== 200) {
    state.errorLogs.push({
      correlationId: correlationID,
      actionPerformed: path,
      statusCode,
      employeeId,
      errorCode: String(errorCode),
      errorMessage,
      errorTimestamp: new Date().toISOString(),
      storeId: state.config.store_id,
      machineId: state.config.workstation_id,
      timeTakenMs,
      synced: !state.offlineMode,
    });
  }
}

const server = http.createServer((req, res) => {
  // Control plane for E2E tests to toggle edge/fault conditions
  if (req.method === 'POST' && req.url === '/__test/reset') {
    seedInitialData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'POST' && req.url === '/__test/state') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const patch = JSON.parse(body || '{}');
      const connectivityChanged =
        ('offlineMode' in patch && patch.offlineMode !== state.offlineMode) ||
        ('idpDown' in patch && patch.idpDown !== state.idpDown);
      Object.assign(state, patch);
      if (connectivityChanged) broadcastHealthStatusUpdate();
      if (patch.config) Object.assign(state.config, patch.config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state: {
        databaseMode: state.databaseMode,
        cameraEnabled: state.cameraEnabled,
        uiEnabled: state.uiEnabled,
        idpDown: state.idpDown,
        offlineMode: state.offlineMode,
        restartCount: state.restartCount,
        securityLogsCount: state.securityLogs.length,
        errorLogsCount: state.errorLogs.length,
      }}));
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/__test/inspect') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      databaseMode: state.databaseMode,
      cameraEnabled: state.cameraEnabled,
      uiEnabled: state.uiEnabled,
      idpDown: state.idpDown,
      offlineMode: state.offlineMode,
      restartCount: state.restartCount,
      config: state.config,
      securityLogs: state.securityLogs,
      errorLogs: state.errorLogs,
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  clients.add(ws);
  const heartbeat = setInterval(() => sendHealthStatusUpdate(ws), HEARTBEAT_MS);
  ws.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(ws);
  });
  ws.on('message', async (raw) => {
    const startMs = Date.now();
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify(envelope(400, '', '/unknown', {
        actionResult: { code: 951, message: 'Payload Error' },
        errorInfo: { code: 9510, message: 'Invalid JSON payload' },
      }, startMs)));
      return;
    }

    const correlationID = msg.correlationID || '';
    const path = msg.path || '';
    const payload = msg.payload || {};

    state.activeTransactions.set(correlationID, { cancelled: false });

    const reply = (
      statusCode: number,
      response: Record<string, any>,
      employeeId = '',
      extraRoot: Record<string, any> = {}
    ) => {
      const out = envelope(statusCode, correlationID, path, response, startMs, extraRoot);
      logAudit(
        statusCode,
        correlationID,
        path,
        employeeId,
        response.errorInfo?.code || '',
        response.errorInfo?.message || '',
        out.processingMs,
        response.actionResult?.code ?? ''
      );
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(out));
      }
      state.activeTransactions.delete(correlationID);
    };

    switch (path) {
      case '/healthCheck': {
        if (payload.simulateFailure) {
          return reply(400, {
            actionResult: { code: 950, message: 'Generic Error' },
            errorInfo: { code: 9502, message: 'API Timeout' },
          });
        }
        return reply(200, healthPayload(), '', {
          idpStatus: state.idpDown
            ? { status: 'DOWN', allServicesDown: true, statusCode: 1515 }
            : 'UP',
        });
      }

      case '/authenticate/credentials': {
        const { employeeId, password, isLogin = false, isTempEmployee = false } = payload;
        if (!employeeId || !password) {
          return reply(400, {
            actionResult: { code: 651, message: 'Credential failed' },
            errorInfo: { code: 9510, message: 'A mandatory field is missing' },
          });
        }
        if (state.idpDown) {
          return reply(400, {
            actionResult: { code: 651, message: 'Credential failed' },
            errorInfo: { code: 6503, message: 'Credentials cannot be authenticated' },
          }, employeeId);
        }
        const user = state.users.get(employeeId);
        if (!user || user.password !== password) {
          return reply(400, {
            actionResult: { code: 651, message: 'Credential failed' },
            errorInfo: { code: 6501, message: 'Credentials not valid' },
          }, employeeId);
        }

        user.last_authenticated_at = new Date().toISOString();
        if (isLogin) {
          user.credentialType = 'credentials';
          user.credentialRefId = correlationID;
        }

        const userInfo: any = {
          employeeId: user.employeeId,
          firstName: user.firstName,
          lastName: user.lastName,
          sessionToken: user.sessionToken,
          pingSession: user.pingSession,
          firstLogin: user.firstLogin,
        };
        if (isTempEmployee && isLogin && user.sponserId) {
          userInfo.sponsorId = user.sponserId;
        }

        const resp: any = {
          actionResult: { code: 601, message: 'Credential Verified' },
          isBiometricRegistered: user.isBiometricRegistered,
          userInfo,
        };
        if (user.credentialType) {
          resp.credentialType = user.credentialType;
          resp.credentialRefId = user.credentialRefId;
        }
        if (isTempEmployee) {
          resp.sosToken = 'eyJvcmdfc3RvcmUiOiI2ODUyMiIsImFsZyI6IlJTMjU2.mockSosToken';
        }
        return reply(200, resp, employeeId);
      }

      case '/register/biometric': {
        const { employeeId, loginCorrelationID } = payload;
        if (!employeeId || !loginCorrelationID) {
          return reply(400, {
            actionResult: { code: 951, message: 'Payload Error' },
            errorInfo: { code: 9510, message: 'A mandatory field is missing' },
          }, employeeId || '');
        }
        if (!state.uiEnabled) {
          return reply(400, {
            actionResult: { code: 950, message: 'Generic Error' },
            errorInfo: { code: 9500, message: 'Generic technical error' },
            message: 'UI cannot be initialized',
          }, employeeId);
        }
        const user = state.users.get(employeeId);
        if (!user) {
          return reply(400, {
            actionResult: { code: 152, message: 'Failed Face Enrollment' },
            errorInfo: { code: 6500, message: "Credentials doesn't exist" },
          }, employeeId);
        }
        if (state.offlineMode && !user.tempRegistration) {
          return reply(400, {
            actionResult: { code: 152, message: 'Failed Face Enrollment' },
            errorInfo: { code: 9506, message: 'Offline mode only supports tempRegistration users' },
          }, employeeId);
        }
        const loginEntry = state.securityLogs.find(
          (l) =>
            l.correlationId === loginCorrelationID &&
            (l.actionPerformed === '/authenticate/credentials' ||
              l.actionPerformed === '/register/tempEmployee')
        );
        if (!loginEntry) {
          return reply(400, {
            actionResult: { code: 152, message: 'Failed Face Enrollment' },
            errorInfo: { code: 6500, message: "Credentials doesn't exist" },
          }, employeeId);
        }
        if (loginEntry.statusCode !== 200) {
          return reply(400, {
            actionResult: { code: 152, message: 'Failed Face Enrollment' },
            errorInfo: { code: 6501, message: 'Credentials not valid' },
          }, employeeId);
        }
        if (payload.simulateUiClose) {
          return reply(400, {
            actionResult: { code: 950, message: 'Generic Error' },
            errorInfo: { code: 9509, message: 'Back UI navigation' },
          }, employeeId);
        }
        if (payload.simulateVisionError) {
          return reply(400, {
            actionResult: { code: 152, message: 'Failed Face Enrollment' },
            errorInfo: { code: 1502, message: 'Biometric requirements not met' },
          }, employeeId);
        }
        if (payload.simulateDuplicateTemp) {
          return reply(400, {
            actionResult: { code: 152, message: 'Failed Face Enrollment' },
            errorInfo: { code: 1511, message: 'Account creation failed — account already exists.' },
          }, employeeId);
        }

        user.isBiometricRegistered = true;
        user.uuid = user.uuid || `uuid-${employeeId}-${Date.now()}`;
        return reply(200, {
          actionResult: { code: 100, message: 'Face Enrollment Successful' },
          uuid: user.uuid,
        }, employeeId);
      }

      case '/authenticate/biometric': {
        const {
          employeeId,
          uiDelay = 2.5,
          isLogin = false,
          simulateDbError = false,
          simulateFaceMismatch = false,
          simulateTimeout = false,
          simulateMultipleFaces = false,
          simulateVisionCode = '',
        } = payload;

        if (simulateDbError) {
          state.databaseMode = 'Memory';
          return reply(400, {
            actionResult: { code: 950, message: 'Generic Error' },
            errorInfo: { code: 9524, message: 'Local database error' },
          }, employeeId || '');
        }

        if (payload.simulateUiClose) {
          // Spec: closing the UI (X icon) returns 9509 "Back UI navigation"
          return reply(400, {
            actionResult: { code: 950, message: 'Generic Error' },
            errorInfo: { code: 9509, message: 'Back UI navigation' },
          }, employeeId || '');
        }

        if (payload.simulateHangMs) {
          // Keeps the transaction in flight so /terminate/transaction can cancel it.
          // A cancelled transaction is dropped without a response.
          setTimeout(() => {
            const tx = state.activeTransactions.get(correlationID);
            if (!tx || tx.cancelled) {
              state.activeTransactions.delete(correlationID);
              return;
            }
            reply(200, {
              actionResult: { code: 102, message: 'Face Authenticated' },
              credentialType: 'biometric',
            }, employeeId || '', { modelUsed: 'mbfv1' });
          }, Number(payload.simulateHangMs));
          return;
        }

        if (!state.cameraEnabled) {
          if (state.vvCameraOpen) {
            return reply(400, {
              actionResult: { code: 952, message: 'Hardware Error' },
              errorInfo: { code: 9520, message: 'Agent - Camera unavailable' },
            }, employeeId || '');
          }
          // Spec: camera OFF and VV cameras closed -> turn the camera ON and proceed;
          // leave it ON afterwards unless DisableCamera / SilentModeEnabled is set.
          state.cameraEnabled = !(state.config.DisableCamera || state.config.SilentModeEnabled);
        }

        if (!state.uiEnabled && uiDelay === 0) {
          return reply(400, {
            actionResult: { code: 950, message: 'Generic Error' },
            errorInfo: { code: 9500, message: 'Generic technical error' },
            message: 'UI cannot be initialized',
          }, employeeId || '');
        }

        if (uiDelay > 0 && !employeeId) {
          // Send intermediate 1500 pending decision once
          ws.send(JSON.stringify(envelope(400, correlationID, path, {
            actionResult: { code: 150, message: 'Face Re-scan' },
            errorInfo: { code: 1500, message: 'Pending decision' },
          }, startMs)));
        }

        if (simulateTimeout) {
          return reply(200, {
            actionResult: { code: 153, message: 'Face Authentication failed' },
            errorInfo: { code: 1504, message: 'Timeout occurred during live selfie capture' },
          }, employeeId || '');
        }

        if (payload.simulateNoFace) {
          return reply(400, {
            actionResult: { code: 150, message: 'Face Re-scan' },
            errorInfo: { code: 1503, message: 'Invalid image / No face found' },
          }, employeeId || '');
        }

        if (simulateMultipleFaces) {
          return reply(400, {
            actionResult: { code: 150, message: 'Face Re-scan' },
            errorInfo: { code: 1501, message: 'Multiple face detected' },
          }, employeeId || '');
        }

        if (payload.simulateAmbiguousMatch) {
          // 1:N search returned more than one candidate -> secondary verification
          return reply(400, {
            actionResult: { code: 153, message: 'Failed Face Authentication' },
            errorInfo: { code: 1512, message: 'Secondary verification required' },
          }, employeeId || '');
        }

        if (simulateVisionCode) {
          const visionMap: Record<string, string> = {
            'Too close': 'Move back',
            'Too far': 'Move closer',
            'Close to right edge': 'Center your head in the frame',
            'Close to left edge': 'Center your head in the frame',
            'Close to top edge': 'Center your head in the frame',
            'Close to bottom edge': 'Center your head in the frame',
            'Too blurry': 'Hold Still',
            'Eyeglasses detected': 'Remove glasses',
            'Facemask detected': 'Remove mask',
            'Chin too far left': 'Look at the camera',
            'Chin too far right': 'Look at the camera',
            'Chin too far up / Point camera at face': 'Look at the camera',
            'Chin too far down / Point camera at face': 'Look at the camera',
            'Image too dim': 'Too dim - increase lighting',
            'Image too bright': 'Too bright - lower lighting',
            'Face low confidence value': 'Center your head in the frame',
            'Eyes closed': 'Hold still',
            'Mouth open': 'Close mouth',
            'Face tilted right': 'Straighten head',
            'Face tilted left': 'Straighten head',
          };
          return reply(400, {
            actionResult: { code: 150, message: 'Face Re-scan' },
            errorInfo: {
              code: 1502,
              message: 'Biometric requirements not met',
              uiGuidance: visionMap[simulateVisionCode] || 'Center your head in the frame',
            },
          }, employeeId || '');
        }

        // Resolve user (1:1 if employeeId given, else 1:N default to rt00001 or specified match)
        const targetId = employeeId || payload.simulatedMatchedEmployeeId || 'rt00001';
        const user = state.users.get(targetId);

        if (!user || !user.isBiometricRegistered) {
          return reply(400, {
            actionResult: { code: 153, message: 'Failed Face Authentication' },
            errorInfo: { code: 1506, message: 'User not found' },
          }, targetId);
        }

        if (simulateFaceMismatch) {
          return reply(400, {
            actionResult: { code: 153, message: 'Failed Face Authentication' },
            errorInfo: { code: 1505, message: "User's face does not match reference selfie" },
          }, targetId);
        }

        // Digital Twin check (1:N or 1:1 with expired/missing last_authenticated_at)
        if (user.digital_twin_status === 'twin') {
          if (!employeeId) {
            return reply(400, {
              actionResult: { code: 153, message: 'Failed Face Authentication' },
              errorInfo: { code: 1512, message: 'Secondary verification required' },
            }, targetId);
          }
          if (!user.last_authenticated_at || state.periodicIntervalMinutes === 0) {
            return reply(400, {
              actionResult: { code: 153, message: 'Failed Face Authentication' },
              errorInfo: { code: 1512, message: 'Secondary verification required' },
            }, targetId);
          }
          const ageMinutes = (Date.now() - Date.parse(user.last_authenticated_at)) / 60_000;
          if (ageMinutes > state.periodicIntervalMinutes) {
            return reply(400, {
              actionResult: { code: 153, message: 'Failed Face Authentication' },
              errorInfo: { code: 1512, message: 'Secondary verification required' },
            }, targetId);
          }
        }

        // Temp registration online revalidation check
        if (user.tempRegistration && !state.offlineMode && !state.idpDown) {
          if (state.profileMissingOnRevalidate) {
            return reply(400, {
              actionResult: { code: 153, message: 'Failed Face Authentication' },
              errorInfo: { code: 1506, message: 'User not found' },
            }, targetId);
          }
          if (state.storeIdMismatchOnRevalidate) {
            return reply(200, {
              actionResult: { code: 153, message: 'Failed Face Authentication' },
              errorInfo: { code: 1509, message: 'Token Expired' },
              userInfo: { employeeId: user.employeeId, firstName: user.firstName },
            }, targetId, { storeIdMismatch: true, modelUsed: 'mbfv1' });
          }
          user.tempRegistration = false;
        }

        // Temp employee expiry check
        if (user.isTempEmployee && user.profileExpiryTimestamp && Date.now() > user.profileExpiryTimestamp) {
          return reply(400, {
            actionResult: { code: 153, message: 'Failed Face Authentication' },
            errorInfo: { code: 1506, message: 'User not found' },
          }, targetId);
        }

        // Token checks for regular employees
        if (!user.isTempEmployee && !user.tempRegistration) {
          const hasTokens = Boolean(user.sessionToken || user.pingSession?.access_token);
          if (!hasTokens) {
            return reply(200, {
              actionResult: { code: 153, message: 'Face Authentication failed' },
              errorInfo: { code: 1510, message: 'IDP is down' },
              userInfo: { employeeId: user.employeeId, firstName: user.firstName },
            }, targetId, { modelUsed: 'mbfv1' });
          }
          const isExpired =
            user.isSMTokenExpired ||
            (user.pingSession && user.pingSession.expires_at < Date.now());
          if (isExpired) {
            if (state.offlineMode || state.idpDown || state.allServicesDown) {
              return reply(200, {
                actionResult: { code: 153, message: 'Face Authentication failed' },
                errorInfo: { code: 1510, message: 'IDP is down' },
                userInfo: { employeeId: user.employeeId, firstName: user.firstName },
              }, targetId, { modelUsed: 'mbfv1' });
            }
            return reply(200, {
              actionResult: { code: 153, message: 'Failed Face Authentication' },
              errorInfo: { code: 1509, message: 'Token Expired' },
              userInfo: { employeeId: user.employeeId, firstName: user.firstName },
            }, targetId, { modelUsed: 'mbfv1' });
          }
        }

        if (isLogin) {
          user.credentialType = 'biometric';
          user.credentialRefId = correlationID;
        }

        const resp: any = {
          actionResult: { code: 102, message: 'Face Predict Successful' },
          uuid: user.uuid,
          userInfo: {
            employeeId: user.employeeId,
            firstName: user.firstName,
            lastName: user.lastName,
            sessionToken: user.sessionToken,
            pingSession: user.pingSession,
          },
        };
        if (user.credentialType) {
          resp.credentialType = user.credentialType;
          resp.credentialRefId = user.credentialRefId;
        }
        return reply(200, resp, targetId, { modelUsed: 'mbfv1' });
      }

      case '/register/barcode': {
        const { employeeId, pin, validity } = payload;
        if (!employeeId || validity === undefined) {
          return reply(400, {
            actionResult: { code: 652, message: 'Barcode creation failed' },
            errorInfo: { code: 9510, message: 'A mandatory field is missing' },
          }, employeeId || '');
        }
        const user = state.users.get(employeeId);
        if (!user) {
          return reply(400, {
            actionResult: { code: 652, message: 'Barcode creation failed' },
            errorInfo: { code: 6500, message: 'Credentials do not exist' },
          }, employeeId);
        }
        if (user.isTempEmployee && user.profileExpiryTimestamp && Date.now() > user.profileExpiryTimestamp) {
          return reply(400, {
            actionResult: { code: 652, message: 'Barcode creation failed' },
            errorInfo: { code: 6500, message: 'Credentials do not exist' },
          }, employeeId);
        }
        const pinRequired = state.config.FallBackAuthWithPinEnabled === 'Y';
        if (pinRequired && !pin) {
          return reply(400, {
            actionResult: { code: 652, message: 'Barcode creation failed' },
            errorInfo: { code: 9510, message: 'A mandatory field is missing' },
          }, employeeId);
        }
        if (pin && (!/^\d{4}$/.test(pin))) {
          return reply(400, {
            actionResult: { code: 652, message: 'Barcode creation failed' },
            errorInfo: { code: 9510, message: 'Invalid PIN format' },
          }, employeeId);
        }

        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let rand = '';
        for (let i = 0; i < 11; i++) {
          rand += chars[Math.floor(Math.random() * chars.length)];
        }
        const barcodeData = `BI${rand}`; // 13 chars total
        const now = Date.now();
        state.barcodes.set(barcodeData.toUpperCase(), {
          barcodeData,
          employeeId,
          pin,
          createdAt: now,
          expiresAt: now + Number(validity) * 1000,
        });

        return reply(200, {
          actionResult: { code: 602, message: 'Barcode created' },
          barcodeData,
          firstName: user.firstName || '',
          middleName: user.middleName || '',
          lastName: user.lastName || '',
        }, employeeId);
      }

      case '/authenticate/barcode': {
        const { barcodeData, pin, employeeId, isLogin = false } = payload;
        if (!barcodeData || typeof barcodeData !== 'string' || barcodeData.length !== 13) {
          return reply(400, {
            actionResult: { code: 653, message: 'Barcode Authentication Failed' },
            errorInfo: { code: 9510, message: 'A mandatory field is missing' },
          }, employeeId || '');
        }
        const pinRequired = state.config.FallBackAuthWithPinEnabled === 'Y';
        if (!pin && !state.uiEnabled) {
          return reply(400, {
            actionResult: { code: 950, message: 'Generic Error' },
            errorInfo: { code: 9500, message: 'Generic technical error' },
            message: 'UI cannot be initialized',
          }, employeeId || '');
        }
        if (pinRequired && !pin) {
          return reply(400, {
            actionResult: { code: 653, message: 'Barcode Authentication Failed' },
            errorInfo: { code: 9510, message: 'A mandatory field is missing' },
          }, employeeId || '');
        }

        const record = state.barcodes.get(barcodeData.toUpperCase());
        if (!record || Date.now() > record.expiresAt) {
          return reply(400, {
            actionResult: { code: 653, message: 'Barcode Authentication Failed' },
            errorInfo: { code: 6522, message: 'Barcode data does not exist' },
          }, employeeId || '');
        }
        if (employeeId && record.employeeId !== employeeId) {
          return reply(400, {
            actionResult: { code: 653, message: 'Barcode Authentication Failed' },
            errorInfo: { code: 6524, message: 'User mismatch' },
          }, employeeId);
        }
        if (pinRequired && record.pin !== pin) {
          return reply(400, {
            actionResult: { code: 653, message: 'Barcode Authentication Failed' },
            errorInfo: { code: 6523, message: 'Passcode mismatch' },
          }, record.employeeId);
        }

        const user = state.users.get(record.employeeId)!;
        // Spec: once IdPs are back, temp-registered profiles are not served from the local cache,
        // and expired temp profiles are rejected.
        if (
          (user.tempRegistration && !state.offlineMode && !state.idpDown) ||
          (user.isTempEmployee && user.profileExpiryTimestamp && Date.now() > user.profileExpiryTimestamp)
        ) {
          return reply(400, {
            actionResult: { code: 653, message: 'Barcode Authentication Failed' },
            errorInfo: { code: 6522, message: 'Barcode data does not exist' },
          }, record.employeeId);
        }
        user.last_authenticated_at = new Date().toISOString();
        if (isLogin) {
          user.credentialType = 'barcode';
          user.credentialRefId = correlationID;
        }

        return reply(200, {
          actionResult: { code: 603, message: 'Barcode Authenticated' },
          credentialType: user.credentialType || 'barcode',
          credentialRefId: user.credentialRefId || correlationID,
          userInfo: {
            employeeId: user.employeeId,
            firstName: user.firstName,
            lastName: user.lastName,
          },
        }, user.employeeId);
      }

      case '/register/tempEmployee': {
        if (!payload.employeeId || !payload.firstName || !payload.sponserId) {
          return reply(400, {
            actionResult: { code: 951, message: 'Payload Error' },
            errorInfo: { code: 9510, message: 'A mandatory field is missing' },
          }, payload.employeeId || '');
        }
        if (state.users.has(payload.employeeId)) {
          return reply(400, {
            actionResult: { code: 152, message: 'Failed Face Enrollment' },
            errorInfo: { code: 1511, message: 'Account creation failed — account already exists' },
          }, payload.employeeId);
        }
        const now = Date.now();
        state.users.set(payload.employeeId, {
          employeeId: payload.employeeId,
          firstName: payload.firstName,
          middleName: payload.middleName || '',
          lastName: payload.familyName || payload.lastName || '',
          isBiometricRegistered: false,
          digital_twin_status: 'clear',
          digital_twin_pairs: [],
          last_twin_check_at: null,
          isTempEmployee: true,
          tempRegistration: Boolean(state.offlineMode),
          sponserId: payload.sponserId,
          profileExpiryTimestamp: payload.profileExpiryTimestamp
            ? payload.profileExpiryTimestamp * 1000
            : now + 86400_000,
          firstLogin: now,
          lastRefresh: now,
        });
        return reply(200, {
          actionResult: { code: 900, message: 'Operation Success' },
        }, payload.employeeId);
      }

      case '/userinfo': {
        const { employeeId, assignStore = false } = payload;
        const user = state.users.get(employeeId);
        if (!user) {
          return reply(400, {
            actionResult: { code: 651, message: 'Credential failed' },
            errorInfo: { code: 6500, message: 'Credentials does not exist' },
          }, employeeId || '');
        }
        if (assignStore) {
          user.store_id = state.config.store_id;
          user.workstation = state.config.workstation_id;
          user.last_authenticated_at = new Date().toISOString();
        }
        user.lastRefresh = Date.now();
        return reply(200, {
          actionResult: { code: 900, message: 'Operation Success' },
          uuid: user.uuid,
          credentialType: user.credentialType,
          credentialRefId: user.credentialRefId,
          userInfo: {
            employeeId: user.employeeId,
            firstName: user.firstName,
            lastName: user.lastName,
            store_id: user.store_id,
            workstation: user.workstation,
            lastRefresh: user.lastRefresh,
          },
        }, employeeId);
      }

      case '/terminate/transaction': {
        const { targetCorrelationID } = payload;
        if (!targetCorrelationID || !state.activeTransactions.has(targetCorrelationID)) {
          return reply(400, {
            actionResult: { code: 950, message: 'Generic error' },
            errorInfo: { code: 9503, message: 'Invalid correlationID' },
          });
        }
        state.activeTransactions.get(targetCorrelationID)!.cancelled = true;
        return reply(200, {
          actionResult: { code: 900, message: 'Operation Success' },
        });
      }

      case '/forgetMe': {
        const { employeeId } = payload;
        if (!employeeId || !state.users.has(employeeId)) {
          return reply(400, {
            actionResult: { code: 651, message: 'Credential failed' },
            errorInfo: { code: 6500, message: 'Credentials does not exist' },
          }, employeeId || '');
        }
        if (payload.simulateDeleteFailure) {
          return reply(400, {
            actionResult: { code: 950, message: 'Generic Error' },
            errorInfo: { code: 9506, message: 'API Error' },
          }, employeeId);
        }
        state.users.delete(employeeId);
        return reply(200, {
          actionResult: { code: 900, message: 'Operation Success' },
        }, employeeId);
      }

      case '/uploadLogs': {
        const { logType } = payload;
        const allowed = ['error', 'info', 'debug', 'all'];
        if (!logType || !allowed.includes(logType)) {
          return reply(400, {
            actionResult: { code: 950, message: 'Generic Error' },
            errorInfo: { code: 9500, message: 'Generic technical error' },
          });
        }
        state.securityLogs.forEach((l) => (l.synced = true));
        state.errorLogs.forEach((l) => (l.synced = true));
        return reply(200, {
          actionResult: { code: 900, message: 'Logs uploaded successfully' },
        });
      }

      case '/setConfiguration': {
        const configs = payload.configurations;
        if (!configs || typeof configs !== 'object' || Object.keys(configs).length === 0) {
          return reply(400, {
            actionResult: { code: 950, message: 'Generic Error' },
            errorInfo: { code: 9500, message: 'Generic technical error' },
          });
        }
        const criticalKeys = ['backend_url', 'store_id'];
        let restartTriggered = false;
        for (const [k, v] of Object.entries(configs)) {
          if (criticalKeys.includes(k) && state.config[k] !== v) {
            restartTriggered = true;
          }
          state.config[k] = v;
        }
        if (restartTriggered) {
          state.restartCount += 1;
        }
        return reply(200, {
          actionResult: { code: 900, message: 'Configuration updated successfully' },
        });
      }

      case '/user/token': {
        const { employeeId, tokenType } = payload;
        if (!employeeId || !Array.isArray(tokenType) || tokenType.length === 0) {
          return reply(400, {
            actionResult: { code: 951, message: 'Payload Error' },
            errorInfo: { code: 9510, message: 'A mandatory field is missing' },
          }, employeeId || '');
        }
        const user = state.users.get(employeeId);
        if (!user) {
          return reply(400, {
            actionResult: { code: 651, message: 'Credential failed' },
            errorInfo: { code: 6500, message: 'Credentials does not exist' },
          }, employeeId);
        }
        if (state.idpDown) {
          return reply(400, {
            actionResult: { code: 651, message: 'Credential failed' },
            errorInfo: { code: 1510, message: 'IDP is down' },
          }, employeeId);
        }

        const userTokens: any[] = [];
        for (const t of tokenType) {
          if (t === 'PING' && user.pingSession?.access_token) {
            if (user.pingSession.expires_at < Date.now()) {
              // Simulate auto-refresh
              user.pingSession.access_token = `refreshed.ping.token.${Date.now()}`;
              user.pingSession.expires_at = Date.now() + 7199_000;
            }
            userTokens.push({
              type: 'PING',
              token: user.pingSession.access_token,
              createdAt: new Date(user.lastRefresh).toISOString(),
              expiresIn: 7199,
            });
          } else if (t === 'SM' && user.sessionToken) {
            if (user.isSMTokenExpired) {
              user.sessionToken = `refreshed.sm.token.${Date.now()}`;
              user.isSMTokenExpired = false;
            }
            userTokens.push({
              type: 'SM',
              token: user.sessionToken,
              createdAt: new Date(user.lastRefresh).toISOString(),
              expiresIn: 46800,
            });
          }
        }

        return reply(200, {
          actionResult: { code: 900, message: 'Operation Successful' },
          userTokens,
        }, employeeId);
      }

      case '/notify/bio-camera': {
        const { action } = payload;
        if (action !== 'ON' && action !== 'OFF') {
          return reply(400, {
            actionResult: { code: 951, message: 'Payload Error' },
            errorInfo: { code: 9510, message: 'A mandatory field is missing' },
          });
        }
        const cameraBefore = state.cameraEnabled;
        if (action === 'OFF') {
          state.cameraEnabled = false;
        } else if (!state.config.DisableCamera && !state.config.SilentModeEnabled) {
          state.cameraEnabled = true;
        }
        reply(200, {
          actionResult: { code: 706, message: 'Camera Action success' },
        });
        // Event-driven update on camera status change (separate from the interval heartbeat)
        if (cameraBefore !== state.cameraEnabled) broadcastHealthStatusUpdate();
        return;
      }

      default:
        return reply(400, {
          actionResult: { code: 950, message: 'Generic Error' },
          errorInfo: { code: 9500, message: `Unknown path: ${path}` },
        });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Mock Charlie StoreOS Security Agent listening on ws://127.0.0.1:${PORT}`);
});
