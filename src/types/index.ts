export interface Chat {
  id: number;
  title: string;
  agent: string;
  openclaw_session_id: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  chat_id: number;
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  finish_reason: string | null;
  created_at: string;
}
