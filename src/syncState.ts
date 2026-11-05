export const SYNC_INTERVAL_MS = 300_000;
export interface SyncConfig { enabled:boolean; url:string; deviceId:string; direct:boolean }
export interface SyncConflict { key:string; local:Record<string,unknown>|null; remote:Record<string,unknown>|null }
export interface SyncView {
  pending:number;
  config:SyncConfig;
  hasToken:boolean;
  status:{running:boolean;lastSuccess:string|null;error:string|null;uploaded:number;downloaded:number};
  conflicts:SyncConflict[];
}
