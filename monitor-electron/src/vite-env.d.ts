/// <reference types="vite/client" />

interface RecorderBridge {
  setWsUrl: (url: string) => Promise<string>;
  send: (obj: unknown) => void;
  onMessage: (handler: (msg: Record<string, unknown> | null) => void) => () => void;
  onStatus: (handler: (s: { state?: string }) => void) => () => void;
}

declare global {
  interface Window {
    recorderBridge?: RecorderBridge;
  }
}

export {};
