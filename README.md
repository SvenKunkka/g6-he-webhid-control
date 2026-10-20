<!-- SVENKUNKKA-README-NAV:BEGIN -->
[中文项目说明](#project-overview-zh) · [English overview](#project-overview-en) · [维护者 X / Maintainer on X](https://x.com/Svenu1s5)
<!-- SVENKUNKKA-README-NAV:END -->

# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)


---

<!-- SVENKUNKKA-PROJECT-INFO:BEGIN -->

<a id="project-overview-zh"></a>
## 中文项目说明

G6 HE 的浏览器 WebHID 配置控制台，基于 React 与 vinext。源码包含原厂与 DIY 两种协议分支，提供设备连接、DPI、回报率、按键映射、状态读取和配置恢复操作。

**使用入口：** 使用 Node.js 22.13.0 及以上，运行 `npm install`、`npm run dev`。从支持 WebHID 的浏览器打开页面，明确选择匹配设备；主要实现位于 [G6Console.tsx](app/components/G6Console.tsx)。

**范围说明：** 页面包含真实设备写入及恢复配置命令，不能当作纯演示使用。源码中的可选参数和成功日志不等于已完成实机性能验收；原 README 的 vinext-starter 部分仅为基础框架说明。

<a id="project-overview-en"></a>
## English project overview

A browser-based WebHID configuration console for G6 HE, built with React and vinext. The code includes vendor and DIY protocol branches for connection, DPI, polling rate, button mapping, status reads and configuration recovery.

**Getting started:** Use Node.js 22.13.0 or later, run `npm install` and `npm run dev`, then open the page in a WebHID-capable browser and explicitly select a matching device. The main implementation is [G6Console.tsx](app/components/G6Console.tsx).

**Scope:** The page includes real device-write and configuration-reset commands, so it is not merely a demo. Available settings and success messages in source code do not establish hardware performance validation. The original vinext-starter README section describes the base framework only.

**仓库维护者 / Repository maintainer:** [SvenKunkka](https://github.com/SvenKunkka) · [X / Twitter](https://x.com/Svenu1s5)

<!-- SVENKUNKKA-PROJECT-INFO:END -->
