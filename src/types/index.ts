export interface Project {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
}

export interface Task {
  id: number;
  project_id: number;
  title: string;
  status: string;
  openclaw_session_id: string | null;
  agent: string | null;
  created_at: string;
}

export interface Note {
  id: number;
  task_id: number;
  body: string;
  pinned: number;
  created_at: string;
}

export interface Message {
  id: number;
  task_id: number;
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  finish_reason: string | null;
  created_at: string;
}
