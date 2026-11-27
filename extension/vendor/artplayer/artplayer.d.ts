export interface ArtplayerInstance {
  url: string;
  mask: { show: boolean };
  on(event: string, callback: (...args: any[]) => void): void;
  reset(): void;
  destroy(): void;
}

export interface ArtplayerConstructor {
  PLAYBACK_RATE: number[];
  RECONNECT_TIME_MAX: number;
  new (options: Record<string, any>): ArtplayerInstance;
}

declare const Artplayer: ArtplayerConstructor;
export default Artplayer;
