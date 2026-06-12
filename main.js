// main.js — Electron entry point. Launches the native desktop window.
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#05060f',
    title: 'COMET 88 — Plane Dodger',
    autoHideMenuBar: true,
    webPreferences: {
      // Renderer loads three.js locally via <script type="importmap">.
      // No node integration needed in the renderer for this game.
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // keep rAF running at full speed
    }
  });

  win.loadFile('index.html', process.env.SHOT ? { search: 'shot' } : {});

  // Surface renderer console + load failures to the terminal (handy for debugging).
  win.webContents.on('console-message', (_e, level, message) => {
    console.log('[renderer]', message);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer-gone]', details.reason);
  });

  // Uncomment to debug visually:
  // win.webContents.openDevTools();

  // Dev-only auto-screenshot hook: launch with SHOT=1 to capture the menu,
  // then the game ~3s in, to a file. Used to verify model orientation/scale.
  if (process.env.SHOT) {
    const fs = require('fs');
    const grab = async (name, delay) => {
      try {
        await new Promise(r => setTimeout(r, delay));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, name), img.toPNG());
        console.log('[shot]', name);
      } catch (e) { console.error('[shot-fail]', name, e && e.message); }
    };
    win.webContents.once('did-finish-load', async () => {
      await grab('shot_menu.png', 1200);
      // game.js auto-starts the run via the ?shot flag.
      await grab('shot_game.png', 6000);
      await grab('shot_game2.png', 4000);
      await grab('shot_game3.png', 4000);
      await new Promise(r => setTimeout(r, 500)); // let file flush
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
