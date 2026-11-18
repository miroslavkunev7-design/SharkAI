export type ChatToolPlatform = 'web-desktop' | 'web-mobile' | 'windows';
export type ChatToolInput = 'prompt' | 'image' | 'pdf' | 'dataset' | 'document' | 'none';

export interface ChatTool {
  id: string;
  label: string;
  description: string;
  group: string;
  input: ChatToolInput;
  platforms: ChatToolPlatform[];
  available: boolean;
  reason?: string;
}

export interface ChatToolResult {
  id: string;
  toolId: string;
  label: string;
  status: 'started' | 'completed';
  usageTokens?: number;
  text?: string;
  projectId?: string;
  url?: string;
  artifact?: { url: string; mimeType: string };
  sources?: Array<{ title: string; url: string }>;
}
