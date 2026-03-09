// Patches @discordjs/voice for Electron compatibility:
// 1. import() -> require() for encryption libs (CJS/ESM interop fix)
// 2. Adds WS close code logging for debugging
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', '@discordjs', 'voice', 'dist', 'index.js');

if (!fs.existsSync(file)) {
  console.log('patch-voice: @discordjs/voice not found, skipping');
  process.exit(0);
}

let src = fs.readFileSync(file, 'utf-8');
let patched = false;

// Patch 1: import() -> require()
const importBefore = 'const lib = await import(libName)';
const importAfter = 'const lib = require(libName)';
if (src.includes(importBefore)) {
  src = src.replace(importBefore, importAfter);
  patched = true;
  console.log('patch-voice: patched import() -> require()');
}

// Patch 2: Add WS close code logging
const closeBefore = 'onWsClose({ code }) {\n    const canResume';
const closeAfter = 'onWsClose({ code }) {\n    this.debug?.(`[CLOSE] WebSocket closed with code: ${code}`);\n    const canResume';
if (src.includes(closeBefore) && !src.includes('[CLOSE]')) {
  src = src.replace(closeBefore, closeAfter);
  patched = true;
  console.log('patch-voice: added WS close code logging');
}

// Patch 3: import(@snazzah/davey) -> require(@snazzah/davey) with error logging
const daveyImportBefore = 'const lib = await import("@snazzah/davey")';
const daveyRequire = 'const lib = require("@snazzah/davey")';
if (src.includes(daveyImportBefore)) {
  src = src.replace(daveyImportBefore, daveyRequire);
  patched = true;
  console.log('patch-voice: patched davey import() -> require()');
}
// Add error logging to davey catch block
if (src.includes(daveyRequire) && !src.includes('[DAVE]')) {
  src = src.replace(
    daveyRequire + ';\n    Davey = lib;\n  } catch {\n  }',
    daveyRequire + ';\n    Davey = lib;\n    console.log("[DAVE] @snazzah/davey loaded, protocol version:", lib.DAVE_PROTOCOL_VERSION);\n  } catch (daveyErr) {\n    console.error("[DAVE] Failed to load @snazzah/davey:", daveyErr?.message || daveyErr);\n  }'
  );
  patched = true;
  console.log('patch-voice: added davey load error logging');
}

// Patch 4: Add child error logging
const errBefore = 'onChildError(error) {\n    this.emit("error", error);\n  }';
const errAfter = 'onChildError(error) {\n    this.debug?.(`[ERROR] Child error: ${error?.message || error}`);\n    this.emit("error", error);\n  }';
if (src.includes(errBefore) && !src.includes('[ERROR]')) {
  src = src.replace(errBefore, errAfter);
  patched = true;
  console.log('patch-voice: added child error logging');
}

if (patched) {
  fs.writeFileSync(file, src);
  console.log('patch-voice: done');
} else {
  console.log('patch-voice: all patches already applied');
}
