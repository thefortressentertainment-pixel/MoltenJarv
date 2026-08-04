import fs from 'node:fs';
import path from 'node:path';
import { dataHome } from './config/defaults.js';

/**
 * Initiative store: Jarv's proactive idea/opportunity ledger. Jarv invents
 * initiatives on a cadence (web trends + Moltbook + its own capabilities),
 * tracks them here, surfaces them to the user for approval, and (with consent)
 * executes the approved ones. This is what makes Jarv more than a
 * react-to-the-prompt assistant.
 */

export type InitiativeStatus = 'proposed' | 'approved' | 'declined' | 'in_progress' | 'done';

export interface Initiative {
  id: string;
  idea: string;
  rationale: string;
  value: string;
  effort: string;
  status: InitiativeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface InitiativeStore {
  list(): Initiative[];
  get(id: string): Initiative | undefined;
  add(initiative: Omit<Initiative, 'id' | 'status' | 'createdAt' | 'updatedAt'>): Initiative;
  setStatus(id: string, status: InitiativeStatus): Initiative | null;
  openCount(): number;
}

export function initiativesPath(): string {
  return path.join(dataHome(), 'initiatives.json');
}

export function loadInitiatives(): Initiative[] {
  try {
    const raw = JSON.parse(fs.readFileSync(initiativesPath(), 'utf8')) as { initiatives?: Initiative[] };
    return Array.isArray(raw.initiatives) ? raw.initiatives : [];
  } catch {
    return [];
  }
}

function save(initiatives: Initiative[]): void {
  fs.mkdirSync(dataHome(), { recursive: true });
  fs.writeFileSync(initiativesPath(), JSON.stringify({ initiatives }, null, 2) + '\n');
}

function newId(): string {
  return `init-${Date.now().toString(36)}`;
}

export function createInitiativeStore(): InitiativeStore {
  const list = (): Initiative[] => loadInitiatives();

  const store: InitiativeStore = {
    list,
    get: (id) => list().find((i) => i.id === id),
    add: (input) => {
      const now = new Date().toISOString();
      const initiative: Initiative = {
        ...input,
        id: newId(),
        status: 'proposed',
        createdAt: now,
        updatedAt: now,
      };
      save([...list(), initiative]);
      return initiative;
    },
    setStatus: (id, status) => {
      const initiatives = list();
      const target = initiatives.find((i) => i.id === id);
      if (!target) return null;
      target.status = status;
      target.updatedAt = new Date().toISOString();
      save(initiatives);
      return target;
    },
    openCount: () => list().filter((i) => i.status === 'proposed' || i.status === 'approved' || i.status === 'in_progress').length,
  };
  return store;
}
