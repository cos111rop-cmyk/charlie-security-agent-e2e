# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: security-agent.e2e.spec.ts >> Charlie StoreOS Security Agent - Full End-to-End Suite >> 06. /register/tempEmployee creates temporary profile and authenticates with sponsorId when isLogin=true
- Location: tests\security-agent.e2e.spec.ts:99:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 200
Received: 400
```

# Test source

```ts
  23  |   // =========================================================================
  24  |   // 1. PROTOCOL ENVELOPE, HEALTH CHECK & AUDIT LOGGING RULES
  25  |   // =========================================================================
  26  |   test('01. /healthCheck returns 200, DB mode, camera status, and excludes success from SecurityLog', async () => {
  27  |     const res = await client.send('/healthCheck');
  28  |     expect(res.statusCode).toBe(200);
  29  |     expect(res.path).toBe('/healthCheck');
  30  |     expect(res.correlationID).toBeTruthy();
  31  |     expect(res.timeTaken).toMatch(/^\d+ms$/);
  32  |     expect(res.response.actionResult.code).toBe(900);
  33  |     expect(res.response.databaseMode).toBe('DB');
  34  |     expect(res.response.cameraStatus.cameraEnabled).toBe(true);
  35  | 
  36  |     if (IS_MOCK) {
  37  |       const state = await inspectMockState();
  38  |       const hcLogs = state.securityLogs.filter((l: any) => l.actionPerformed === '/healthCheck');
  39  |       expect(hcLogs.length).toBe(0);
  40  |     }
  41  |   });
  42  | 
  43  |   test('02. /healthCheck failure is recorded in ErrorLog with error code 9502', async () => {
  44  |     test.skip(!IS_MOCK, 'Requires mock failure injection');
  45  |     const res = await client.send('/healthCheck', { simulateFailure: true });
  46  |     expect(res.statusCode).toBe(400);
  47  |     expect(res.response.errorInfo.code).toBe(9502);
  48  | 
  49  |     const state = await inspectMockState();
  50  |     expect(state.errorLogs.some((l: any) => l.actionPerformed === '/healthCheck' && l.errorCode === '9502')).toBe(true);
  51  |   });
  52  | 
  53  |   // =========================================================================
  54  |   // 2. CREDENTIAL AUTHENTICATION (/authenticate/credentials)
  55  |   // =========================================================================
  56  |   test('03. /authenticate/credentials succeeds for regular employee and persists credentialRefId when isLogin=true', async () => {
  57  |     const res = await client.send('/authenticate/credentials', {
  58  |       employeeId: 'rt00001',
  59  |       password: 'SecretPassword123',
  60  |       isLogin: true,
  61  |       isTempEmployee: false,
  62  |     });
  63  |     expect(res.statusCode).toBe(200);
  64  |     expect(res.response.actionResult.code).toBe(601);
  65  |     expect(res.response.credentialType).toBe('credentials');
  66  |     expect(res.response.credentialRefId).toBe(res.correlationID);
  67  |     expect(res.response.userInfo.employeeId).toBe('rt00001');
  68  |   });
  69  | 
  70  |   test('04. /authenticate/credentials rejects invalid password with 6501 and missing fields with 9510', async () => {
  71  |     const badPass = await client.send('/authenticate/credentials', {
  72  |       employeeId: 'rt00001',
  73  |       password: 'WrongPassword!',
  74  |     });
  75  |     expect(badPass.statusCode).toBe(400);
  76  |     expect(badPass.response.errorInfo.code).toBe(6501);
  77  | 
  78  |     const missing = await client.send('/authenticate/credentials', {
  79  |       employeeId: 'rt00001',
  80  |     });
  81  |     expect(missing.statusCode).toBe(400);
  82  |     expect(missing.response.errorInfo.code).toBe(9510);
  83  |   });
  84  | 
  85  |   test('05. /authenticate/credentials returns 6503 when IDP is unreachable', async () => {
  86  |     test.skip(!IS_MOCK, 'Requires mock IDP fault injection');
  87  |     await setMockState({ idpDown: true });
  88  |     const res = await client.send('/authenticate/credentials', {
  89  |       employeeId: 'rt00001',
  90  |       password: 'SecretPassword123',
  91  |     });
  92  |     expect(res.statusCode).toBe(400);
  93  |     expect(res.response.errorInfo.code).toBe(6503);
  94  |   });
  95  | 
  96  |   // =========================================================================
  97  |   // 3. TEMP EMPLOYEE REGISTRATION & BIOMETRIC ENROLLMENT
  98  |   // =========================================================================
  99  |   test('06. /register/tempEmployee creates temporary profile and authenticates with sponsorId when isLogin=true', async () => {
  100 |     const tempId = 'T005900099';
  101 |     const reg = await client.send('/register/tempEmployee', {
  102 |       employeeId: tempId,
  103 |       consentGiven: true,
  104 |       firstName: 'John',
  105 |       familyName: 'Doe',
  106 |       middleName: 'M',
  107 |       dob: '1990-01-01',
  108 |       employeeRole: 'T',
  109 |       sponserId: 'rt00001',
  110 |       profileExpiryTimestamp: Math.floor(Date.now() / 1000) + 86400,
  111 |     });
  112 |     expect(reg.statusCode).toBe(200);
  113 |     expect(reg.response.actionResult.code).toBe(900);
  114 | 
  115 |     // Enroll biometrics using the tempEmployee registration correlationID
  116 |     const bioReg = await client.send('/register/biometric', {
  117 |       employeeId: tempId,
  118 |       loginCorrelationID: reg.correlationID,
  119 |       consentGiven: true,
  120 |       consentVersion: 'v1.0',
  121 |       state: 'MA',
  122 |     });
> 123 |     expect(bioReg.statusCode).toBe(200);
      |                               ^ Error: expect(received).toBe(expected) // Object.is equality
  124 |     expect(bioReg.response.actionResult.code).toBe(100);
  125 |   });
  126 | 
  127 |   test('07. /register/biometric validates mandatory fields (9510), unknown user (6500), and invalid loginCorrelationID', async () => {
  128 |     const missing = await client.send('/register/biometric', { employeeId: 'rt00001' });
  129 |     expect(missing.statusCode).toBe(400);
  130 |     expect(missing.response.errorInfo.code).toBe(9510);
  131 | 
  132 |     const unknownUser = await client.send('/register/biometric', {
  133 |       employeeId: 'unknown_999',
  134 |       loginCorrelationID: 'valid-login-cid-001',
  135 |     });
  136 |     expect(unknownUser.statusCode).toBe(400);
  137 |     expect(unknownUser.response.errorInfo.code).toBe(6500);
  138 | 
  139 |     const badLoginCid = await client.send('/register/biometric', {
  140 |       employeeId: 'rt00001',
  141 |       loginCorrelationID: 'non-existent-login-cid',
  142 |     });
  143 |     expect(badLoginCid.statusCode).toBe(400);
  144 |     expect(badLoginCid.response.errorInfo.code).toBe(6500);
  145 |   });
  146 | 
  147 |   // =========================================================================
  148 |   // 4. BIOMETRIC AUTHENTICATION (1:1, 1:N, PASSIVE DELAY, GUIDANCE, DIGITAL TWIN)
  149 |   // =========================================================================
  150 |   test('08. /authenticate/biometric 1:1 active scan succeeds with modelUsed and processingMs metrics', async () => {
  151 |     const res = await client.send('/authenticate/biometric', {
  152 |       employeeId: 'rt00001',
  153 |       uiDelay: 0,
  154 |       isLogin: true,
  155 |       liveness: true,
  156 |       liveness_reco: true,
  157 |     });
  158 |     expect(res.statusCode).toBe(200);
  159 |     expect(res.response.actionResult.code).toBe(102);
  160 |     expect(res.response.credentialType).toBe('biometric');
  161 |     expect(res.modelUsed).toBe('mbfv1');
  162 |     expect(typeof res.processingMs).toBe('number');
  163 |   });
  164 | 
  165 |   test('09. /authenticate/biometric 1:N passive scan emits intermediate 1500 pending decision before 200 match', async () => {
  166 |     test.skip(!IS_MOCK, 'Requires deterministic passive delay simulation');
  167 |     const frames = await client.sendAndCollectAll('/authenticate/biometric', {
  168 |       uiDelay: 2.5,
  169 |       isLogin: false,
  170 |     });
  171 |     expect(frames.length).toBe(2);
  172 |     expect(frames[0].response.actionResult.code).toBe(150);
  173 |     expect(frames[0].response.errorInfo.code).toBe(1500);
  174 |     expect(frames[1].statusCode).toBe(200);
  175 |     expect(frames[1].response.actionResult.code).toBe(102);
  176 |   });
  177 | 
  178 |   test('10. /authenticate/biometric handles mismatch (1505), timeout (1504), and UI vision guidance translation', async () => {
  179 |     test.skip(!IS_MOCK, 'Requires vision fault injection');
  180 |     const mismatch = await client.send('/authenticate/biometric', {
  181 |       employeeId: 'rt00001',
  182 |       uiDelay: 0,
  183 |       simulateFaceMismatch: true,
  184 |     });
  185 |     expect(mismatch.statusCode).toBe(400);
  186 |     expect(mismatch.response.errorInfo.code).toBe(1505);
  187 | 
  188 |     const timeout = await client.send('/authenticate/biometric', {
  189 |       employeeId: 'rt00001',
  190 |       uiDelay: 0,
  191 |       simulateTimeout: true,
  192 |     });
  193 |     expect(timeout.response.errorInfo.code).toBe(1504);
  194 | 
  195 |     const glasses = await client.send('/authenticate/biometric', {
  196 |       employeeId: 'rt00001',
  197 |       uiDelay: 0,
  198 |       simulateVisionCode: 'Eyeglasses detected',
  199 |     });
  200 |     expect(glasses.response.errorInfo.code).toBe(1502);
  201 |     expect(glasses.response.errorInfo.uiGuidance).toBe('Remove glasses');
  202 |   });
  203 | 
  204 |   test('11. Digital Twin detection triggers 1512 on 1:N or unverified 1:1, and clears after secondary auth', async () => {
  205 |     test.skip(!IS_MOCK, 'Requires digital twin seeded user');
  206 |     // 1:N match on a digital twin must demand secondary verification (1512)
  207 |     const oneToN = await client.send('/authenticate/biometric', {
  208 |       uiDelay: 0,
  209 |       simulatedMatchedEmployeeId: 'twin_emp_01',
  210 |     });
  211 |     expect(oneToN.statusCode).toBe(400);
  212 |     expect(oneToN.response.errorInfo.code).toBe(1512);
  213 | 
  214 |     // 1:1 match without prior secondary verification must also return 1512
  215 |     const oneToOneBefore = await client.send('/authenticate/biometric', {
  216 |       employeeId: 'twin_emp_01',
  217 |       uiDelay: 0,
  218 |     });
  219 |     expect(oneToOneBefore.statusCode).toBe(400);
  220 |     expect(oneToOneBefore.response.errorInfo.code).toBe(1512);
  221 | 
  222 |     // Complete secondary verification via credentials
  223 |     const cred = await client.send('/authenticate/credentials', {
```