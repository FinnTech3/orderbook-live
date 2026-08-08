/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional WebSocket feed override; see App.tsx. */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
