export type ChatToolPlatform = 'web-desktop' | 'web-mobile' | 'windows';
export type ChatToolInput = 'prompt' | 'image' | 'pdf' | 'dataset' | 'document' | 'textfile' | 'none';

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
  researchId?: string;
  url?: string;
  artifact?: { url: string; mimeType: string; filename?: string };
  sources?: Array<{ title: string; url: string }>;
}
