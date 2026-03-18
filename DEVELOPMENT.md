<h1>Development</h1>

- [Setup](#setup)
- [Running locally](#running-locally)
- [Visual Studio Code](#visual-studio-code)
- [Deploy changes](#deploy-changes)

# Setup
Checkout the repository and navigate to the `ytdl-material` directory.
```bash
vim ./src/assets/default.json # Local dev config used when YTDL_MODE=debug
npm ci
npm ci --prefix backend
npm run build # Build frontend assets once if you want the backend to serve the UI on :17442
```
This step only needs to be repeated when dependencies change.

# Running locally
Frontend dev server:
```bash
npm start
```

Backend in debug/local-config mode:
```bash
cd backend
npm run debug
```

If you prefer to use the backend-served UI instead of `ng serve`, rebuild the frontend from the repo root with `npm run build`.

# Visual Studio Code
Open the `ytdl-material` directory in Visual Studio Code.

- Use the `Dev: Debug Backend` launch configuration to start the backend with `YTDL_MODE=debug`.
- Use the `Dev: start frontend` task to run `ng serve`.
- Use the `Dev: build frontend for backend` task when you need fresh compiled assets in `backend/public`.

# Deploy changes

Navigate to the `ytdl-material` directory and run `npm run build`. Restart the backend.

Simply restart the backend.
