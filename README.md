# COMET 88 — Plane Dodger

A 3D plane-dodging game built with **Three.js**. Runs in a **web browser** or as
a native **Electron** desktop app from the same code. Fly the *Comet 88* stylized
plane down an infinite neon canyon and dodge *sci-fi train* barriers. Score climbs
with time; speed ramps up the longer you survive.

## Run it

```bash
npm install        # installs three + electron + a local web server
```

The exact same game runs two ways:

**In a web browser:**
```bash
npm run web        # serves over http and opens http://localhost:5173
```

**As a native desktop app (Electron):**
```bash
npm start          # opens the game in its own desktop window
```

> Why a server for the browser? The game uses ES module `import` and loads the
> glTF models with `fetch`. Browsers block both over `file://`, so the page must
> be served over `http://` — that's all `npm run web` does (a plain static
> server, no build step). Electron has no such restriction, so `npm start`
> loads the files directly.

## Controls

| Action | Keys |
| ------ | ---- |
| Move   | Arrow keys / WASD, or the Mouse |
| Start / Restart | Click or Space |

## Your 3D models

The game ships with two real models (loaded via `GLTFLoader`):

- `assets/comet88/scene.gltf` — the player plane (*Comet 88*)
- `assets/scifi_train/scene.gltf` — the obstacle barrier (*Sci-Fi Train*)

> Note: these were downloaded as "DAE" packs but are actually glTF
> (`scene.gltf` + `scene.bin` + PBR textures), so the game uses `GLTFLoader`.
> The Comet 88 model bundles two large decorative "energy aura" spheres that
> are stripped at load time so the plane scales and renders correctly.

If a model is missing or fails to load, the game falls back to a procedural
low-poly stand-in so it always runs. See [CREDITS.md](CREDITS.md) for required
asset attribution.

## Performance design

- **Infinite map** via segment recycling (segments are repositioned, never
  re-allocated during play) + `geometry.dispose()` on full teardown.
- **Object-pooled obstacles** (fixed pool, no per-spawn allocation).
- **Pure-math** movement and **THREE.Box3 AABB** collision — no physics engine.
- Pre-allocated scratch vectors/boxes to avoid per-frame GC hitches.

## Files

- `main.js` — Electron entry point / window.
- `index.html` — canvas host, HUD, overlays, import map for Three.js.
- `game.js` — the Three.js engine (rendering, map, obstacles, collision, loop).
