# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: security-agent.e2e.spec.ts >> Charlie StoreOS Security Agent - Full End-to-End Suite >> 23. Offline temporary registration & online storeIdMismatch revalidation
- Location: tests\security-agent.e2e.spec.ts:449:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 200
Received: 400
```

# Test source

```ts
  366 |     expect(res.statusCode).toBe(400);
  367 |     expect(res.response.errorInfo.code).toBe(9503);
  368 |   });
  369 | 
  370 |   test('19. /uploadLogs validates logType and syncs queued offline logs', async () => {
  371 |     const badType = await client.send('/uploadLogs', { logType: 'invalid_type' });
  372 |     expect(badType.statusCode).toBe(400);
  373 | 
  374 |     const okUpload = await client.send('/uploadLogs', { logType: 'all' });
  375 |     expect(okUpload.statusCode).toBe(200);
  376 |     expect(okUpload.response.actionResult.code).toBe(900);
  377 |   });
  378 | 
  379 |   test('20. /forgetMe wipes user profile from cache and subsequent lookups return 6500', async () => {
  380 |     const del = await client.send('/forgetMe', {
  381 |       employeeId: 'rt00001',
  382 |       deleteFaceId: 'true',
  383 |     });
  384 |     expect(del.statusCode).toBe(200);
  385 |     expect(del.response.actionResult.code).toBe(900);
  386 | 
  387 |     const after = await client.send('/userinfo', { employeeId: 'rt00001' });
  388 |     expect(after.statusCode).toBe(400);
  389 |     expect(after.response.errorInfo.code).toBe(6500);
  390 |   });
  391 | 
  392 |   // =========================================================================
  393 |   // 7. EDGE & RESILIENCE MODES (HEADLESS 9500, DB->MEMORY FALLBACK, OFFLINE TEMP)
  394 |   // =========================================================================
  395 |   test('21. Non-graphical (Headless) mode returns 9500 for UI endpoints but allows PIN barcode & credentials', async () => {
  396 |     test.skip(!IS_MOCK, 'Requires headless mode toggle');
  397 |     await setMockState({ uiEnabled: false });
  398 | 
  399 |     // UI biometric request fails with 9500
  400 |     const bio = await client.send('/authenticate/biometric', {
  401 |       employeeId: 'rt00001',
  402 |       uiDelay: 0,
  403 |     });
  404 |     expect(bio.statusCode).toBe(400);
  405 |     expect(bio.response.errorInfo.code).toBe(9500);
  406 | 
  407 |     // Non-UI credential login still works
  408 |     const cred = await client.send('/authenticate/credentials', {
  409 |       employeeId: 'rt00001',
  410 |       password: 'SecretPassword123',
  411 |     });
  412 |     expect(cred.statusCode).toBe(200);
  413 | 
  414 |     // Barcode with PIN works in headless mode, without PIN fails with 9500
  415 |     const reg = await client.send('/register/barcode', {
  416 |       employeeId: 'rt00001',
  417 |       pin: '4354',
  418 |       validity: 300,
  419 |     });
  420 |     const noPin = await client.send('/authenticate/barcode', {
  421 |       barcodeData: reg.response.barcodeData,
  422 |     });
  423 |     expect(noPin.response.errorInfo.code).toBe(9500);
  424 | 
  425 |     const withPin = await client.send('/authenticate/barcode', {
  426 |       barcodeData: reg.response.barcodeData,
  427 |       pin: '4354',
  428 |       employeeId: 'rt00001',
  429 |     });
  430 |     expect(withPin.statusCode).toBe(200);
  431 |   });
  432 | 
  433 |   test('22. Database corruption auto-switches Agent from DB mode to Memory mode without crashing', async () => {
  434 |     test.skip(!IS_MOCK, 'Requires DB fault injection');
  435 |     const failRes = await client.send('/authenticate/biometric', {
  436 |       employeeId: 'rt00001',
  437 |       uiDelay: 0,
  438 |       simulateDbError: true,
  439 |     });
  440 |     expect(failRes.statusCode).toBe(400);
  441 |     expect(failRes.response.errorInfo.code).toBe(9524);
  442 | 
  443 |     // Health check reflects automatic fallback to Memory mode
  444 |     const hc = await client.send('/healthCheck');
  445 |     expect(hc.statusCode).toBe(200);
  446 |     expect(hc.response.databaseMode).toBe('Memory');
  447 |   });
  448 | 
  449 |   test('23. Offline temporary registration & online storeIdMismatch revalidation', async () => {
  450 |     test.skip(!IS_MOCK, 'Requires offline mode toggle');
  451 |     await setMockState({ offlineMode: true });
  452 | 
  453 |     const tempReg = await client.send('/register/tempEmployee', {
  454 |       employeeId: 'OFFLINE_TEMP_01',
  455 |       consentGiven: true,
  456 |       firstName: 'Offline',
  457 |       familyName: 'Associate',
  458 |       sponserId: 'rt00001',
  459 |     });
  460 |     expect(tempReg.statusCode).toBe(200);
  461 | 
  462 |     const bioEnroll = await client.send('/register/biometric', {
  463 |       employeeId: 'OFFLINE_TEMP_01',
  464 |       loginCorrelationID: tempReg.correlationID,
  465 |     });
> 466 |     expect(bioEnroll.statusCode).toBe(200);
      |                                  ^ Error: expect(received).toBe(expected) // Object.is equality
  467 | 
  468 |     // Offline biometric auth succeeds
  469 |     const offlineAuth = await client.send('/authenticate/biometric', {
  470 |       employeeId: 'OFFLINE_TEMP_01',
  471 |       uiDelay: 0,
  472 |     });
  473 |     expect(offlineAuth.statusCode).toBe(200);
  474 | 
  475 |     // Reconnect online with store mismatch -> returns 1509 + storeIdMismatch: true
  476 |     await setMockState({ offlineMode: false, storeIdMismatchOnRevalidate: true });
  477 |     const onlineReval = await client.send('/authenticate/biometric', {
  478 |       employeeId: 'OFFLINE_TEMP_01',
  479 |       uiDelay: 0,
  480 |     });
  481 |     expect(onlineReval.response.errorInfo.code).toBe(1509);
  482 |     expect(onlineReval.storeIdMismatch).toBe(true);
  483 |   });
  484 | });
  485 | 
```