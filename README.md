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

The app requires an online license activation from `https://autosetter.de`. The backend checks that license before every new/resumed scrape. A device can be released in the app for a change of computer. License enforcement is practical protection against casual sharing, not a promise of tamper resistance.

Before start/resume, RAM, CPU and busy processes are checked. Lead counts come from the imported search limits; unlimited searches show a labeled example. Time ranges are conservative planning estimates, not measured throughput guarantees. macOS uses `caffeinate -d -i -s`, and the desktop uses Electron's display sleep blocker on every OS. Assertions end with the real background job, including error/cancellation. Keep a notebook connected to power, online, and its lid open.

Google Places API keys are entered in Settings. The local AI model is optional and is not bundled: select an existing compatible GGUF instruction model in Settings. Rule-based extraction remains available without it.

`.github/workflows/installers.yml` builds Apple Silicon/Intel DMGs, Windows x64 NSIS setup, and Linux x64 AppImage/deb on native runners and uploads private build artifacts. Tag `v*`, use workflow dispatch after merging it, or push a `codex/autosetter-lifetime-*` branch. macOS public distribution requires Developer ID signing and Apple notarization; Windows Authenticode signing also requires a publisher certificate. Set the relevant release secrets before a public release. The app's paid activation API must be deployed before customers can activate these builds.
