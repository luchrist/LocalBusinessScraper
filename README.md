This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.


## AutoSetter desktop (v0.2)

Use Node 24.19.0 for the native SQLite/LLM dependencies. Install dependencies with `npm ci`, then `npm test` and `npm run desktop:build`. This produces a native installer for the current OS. `npm run desktop:smoke` checks the staged runtime using a fake, local license server; it never generates leads, takes payments or sends emails.

The installer bundles Node and Playwright Chromium, runs its local service on a random loopback port with a per-launch secret, and stores settings, licenses and results in the OS user-data directory. It never bundles `.env.local`, API keys, scraping databases or an owner's model path.

The app makes one online license activation request to `https://www.autosetter.de`. The first successful activation permanently binds the purchased key to that computer. It stores a signed Ed25519 certificate; subsequent app starts and scrape starts/resumes verify the certificate and hardware binding locally, with no license-server request. Copying an installer or certificate cannot activate another computer. Retrying activation on the same hardware is idempotent to recover from a lost response. There is no self-service device release or remote revocation of already issued certificates.

The bundled public key is in `src/lib/license-public-key.ts`. The matching private signing key belongs only in the activation server's secret environment. Never replace this keypair casually: existing installers trust the existing public key. Tests generate independent keys through the license manager factory; the production app has no test-key override.

Before start/resume, RAM, CPU and busy processes are checked. Lead counts come from the imported search limits; unlimited searches show a labeled example. Time ranges are conservative planning estimates, not measured throughput guarantees. macOS uses `caffeinate -d -i -s`, and the desktop uses Electron's display sleep blocker on every OS. Assertions end with the real background job, including error/cancellation. Keep a notebook connected to power, online, and its lid open.

Google Places API keys are entered in Settings. On first launch, AutoSetter automatically downloads and verifies Qwen 2.5 Instruct Q4_K_M (1.5B for up to 12 GB RAM, 7B above 12 GB). Interrupted downloads resume. Settings still supports a manual compatible GGUF model. Models are stored in the OS user-data directory.

`.github/workflows/installers.yml` builds Apple Silicon/Intel DMGs, Windows x64 NSIS setup, and Linux x64 AppImage/deb on native runners. Tags `v*` publish a GitHub Release only after every platform passes unit tests, runtime smoke checks, and packaging. All five installers and SHA-256 checksums are required. Workflow dispatch produces build artifacts without publishing.

The default CI builds currently have ad-hoc macOS signatures and no Windows publisher certificate; they are not Apple-notarized. Public distribution without OS warnings requires Developer ID/notarization and a Windows Authenticode certificate. A Developer ID identity exists on the current development Mac, but release CI does not have its private signing credentials. The one-time activation API must be deployed before buyers can activate the installers.


### Card-backed trial

Trial activation uses a separate signed ASET2 certificate, which older lifetime-only apps reject. The first 50 inserted business results are counted locally across all runs. Before result 51, the app requests the agreed one-time 299 EUR charge. Concurrent requests are serialized; failed or bank-pending payments pause the research. A signed ASET1 lifetime certificate replaces the trial only after successful payment. Paid use verifies locally. The trial can be ended in the license bar before paid use.

### Private website demo on the VPS

`scripts/demo-server.mjs` is a separate server adapter and is not bundled in installers. It starts a private Next backend on 127.0.0.1:3202 and exposes only an authenticated five-result demo and CSV downloads on 127.0.0.1:3201. The server requires its own machine-bound owner activation, model, Google Places key and Mailgun credentials. Configure `AUTOSETTER_DATA_DIR`, `AUTOSETTER_LOCAL_TOKEN`, `AUTOSETTER_DEMO_TOKEN`, `GOOGLE_PLACES_API_KEY`, `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` and `MAILGUN_FROM` in a root-readable systemd environment file. Proxy the adapter over HTTPS; never expose the research backend directly. The landing page sends `AUTOSETTER_DEMO_TOKEN` server-side. Demo CSV links expire after seven days.
