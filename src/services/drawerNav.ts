/**
 * Locals for the slide-out left-nav drawer (views/partials/projectDrawer).
 *
 * The drawer is the single left navigation app-wide (it replaced the old
 * always-visible sidebar). Every page that renders it passes these locals; this
 * helper is the one place that assembles them so routes don't repeat the shape.
 */
import { chats, projects } from './store';
import { listCharacters, type CharacterDef } from './characters';
import { chatStatus } from './chatStatus';
import type { Chat, Project } from '../types';

export interface DrawerLocals {
  drawerProjectId: number | null;
  drawerProjects: Project[];
  drawerCharacters: CharacterDef[];
  drawerChats: Chat[];
  drawerActiveChatId: number;
  drawerWorkingIds: number[];
  /** Which global nav item is active: '' | 'projects' | 'team' | 'tasks' | 'settings'. */
  drawerActiveNav: string;
}

export function buildDrawerLocals(opts?: {
  projectId?: number | null;
  activeChatId?: number;
  activeNav?: string;
}): DrawerLocals {
  const projectId = opts?.projectId ?? null;
  return {
    drawerProjectId: projectId,
    drawerProjects: projects.list(),
    drawerCharacters: listCharacters(),
    // listByProject / listOrphans already exclude drafts + task_execution rows.
    drawerChats: projectId != null ? chats.listByProject(projectId) : chats.listOrphans(),
    drawerActiveChatId: opts?.activeChatId ?? 0,
    drawerWorkingIds: chatStatus.workingIds(),
    drawerActiveNav: opts?.activeNav ?? '',
  };
}
