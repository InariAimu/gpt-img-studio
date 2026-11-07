export type Page = 'gallery' | 'workspace-gallery' | 'workspace' | 'references' | 'presets' | 'jobs' | 'settings';
export type PromptLayer = 'originalPrompt' | 'submittedPrompt' | 'revisedPrompt';
export type ContextMode = 'new' | 'continue';
export type ModelRole = 'image' | 'imageMain' | 'refine' | 'naming';
export interface ModelSelection { providerId: string; modelId: string }
export interface ProviderModel { id: string; name: string; kind: 'text' | 'image'; protocol: 'responses' | 'chat_completions'; vision: boolean; pricing?: Partial<Record<'input' | 'output' | 'cachedInput' | 'imageInput' | 'cachedImageInput' | 'cacheWrite', string>> }
export interface ModelProvider { id: string; name: string; kind: 'openai' | 'deepseek' | 'opencode' | 'custom'; baseUrl: string; models: ProviderModel[] }
export interface Settings {
  network?: NetworkConfig;
  theme: 'system' | 'light' | 'dark';
  accent: string;
  autoNameSessions?: boolean;
  providers?: ModelProvider[];
  modelAssignments?: Record<ModelRole, ModelSelection>;
  generation: { baseUrl: string; apiMode: 'responses' | 'images'; model: string; mainModel: string; providerId?: string };
  refine: { useImageConnection: boolean; baseUrl: string; model: string };
  library: { mode: 'local'; nasUrl: string };
}
export interface NetworkConfig { mode: 'system' | 'manual' | 'direct'; proxyUrl: string }
export interface NetworkState {
  settings: NetworkConfig;
  routes: { id: string; name: string; configured: boolean; invalid: boolean; proxy: string | null }[];
}
export interface Workspace { id: string; name: string; createdAt: string; sortOrder?: number }
export interface Session {
  id: string; workspaceId: string; title: string; draft: string; originalPrompt: string;
  referenceIds: string[]; contextMode: ContextMode; createdAt: string;
  parentSessionId?: string; parentAssetId?: string; lastResponseId?: string;
  size?: string; quality?: string; complexity?: string; moderation?: string; background?: string; outputFormat?: string; outputCompression?: string; imageCount?: string; frameCount?: string; frameDurationMs?: string;
  imageSelection?: ModelSelection | null;
  titleSource?: 'default' | 'manual' | 'automatic'; titleStatus?: 'pending' | 'failed' | 'complete'; titleError?: string; titleAttempted?: boolean;
  lastProviderBaseUrl?: string; lastMainModel?: string; lastProviderId?: string;
}
export interface Asset {
  id: string; title: string; path: string; thumbnailPath?: string; mime: string;
  width: number; height: number; createdAt: string; workspaceId: string; sessionId: string;
  originalPrompt: string; submittedPrompt: string; revisedPrompt?: string;
  referenceIds: string[]; model: string; mainModel?: string; responseId?: string; previousResponseId?: string;
  providerBaseUrl?: string; size: string; quality: string; groupId: string;
  parentAssetId?: string; favorite: boolean; isReference: boolean; demo: boolean;
  referenceOnly?: boolean; referenceSourceId?: string; sourceSessionId?: string;
  galleryImports?: {apiUrl:string;postId:number;postUrl:string;sha256:string;importedAt:string}[];
}
export interface GalleryTaskItem {
  assetId:string; title:string; status:'queued'|'running'|'completed'|'failed'|'interrupted'|'cancelled';
  stage:string; error?:string|null; postId?:number|null; postUrl?:string|null; existing?:boolean;
  label?:{tags:string[];caption_zh:string;safety:'safe'|'sketchy'|'unsafe'}|null;
}
export interface GalleryTask {
  id:string;createdAt:string;finishedAt?:string|null;status:GalleryTaskItem['status'];destination:string;model:string;items:GalleryTaskItem[];
}
export interface Preset { id: string; name: string; description: string; assetId: string; prompt: string; size: string; quality: string; referenceIds: string[]; createdAt: string }
export interface Job { id: string; sessionId: string; prompt: string; originalPrompt?: string; referenceIds?: string[]; contextMode?: ContextMode; previousResponseId?: string; imageSelection?: ModelSelection; status: 'running' | 'completed' | 'failed' | 'interrupted'; createdAt: string; finishedAt?: string; displayElapsedMs?: number; error?: string; assetIds: string[] }
export interface StudioDocument { schemaVersion: number; revision: number; settings: Settings; workspaces: Workspace[]; sessions: Session[]; assets: Asset[]; presets: Preset[]; jobs: Job[] }
export interface Bootstrap { document: StudioDocument; dataDir: string; hasImageKey: boolean; hasRefineKey: boolean; providerKeys?: Record<string, boolean>; storageNotice?: string | null }
export interface UsageComponent { kind: string; model: string; usageAvailable: boolean; tokens: { totalInput: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null }; estimatedCostUsd: string | null; estimateStatus: string; cacheBreakdownKnown: boolean; rawUsage: unknown }
export interface UsageEvent { id: string; sessionId: string; operation: string; provider: { id: string; name: string; kind: string }; model: string; occurredAt: number; requestCount: number; statusCode: number | null; durationMs: number; estimatedCostUsd: string | null; estimateStatus: string; components: UsageComponent[] }
export interface UsageSummary { totalModelUsages: number; modelJournalPath: string; totalRequests: number; unpricedRequests: number; knownEstimatedCostUsd: string; journalPath: string; records: UsageEvent[] }
export interface GenerationRequest { sessionId: string; prompt: string; originalPrompt: string; referenceIds: string[]; size: string; quality: string; complexity?: string; moderation?: string; background?: string; outputFormat?: string; outputCompression?: number; imageCount?: number; frameCount?: number; frameDurationMs?: number; contextMode: ContextMode; imageSelection?: ModelSelection }
export interface RefineResult { prompt: string; model: string }
export interface SessionDeletePreview { token: string; removableReferences: Asset[]; preservedReferenceCount: number; removedResultCount: number; preservedResultCount: number }
export interface WorkspaceDeletePreview { token: string; sessionCount: number; referenceCount: number; removedResultCount: number; preservedResultCount: number }
export interface StudioAction { type: string; [key: string]: unknown }
