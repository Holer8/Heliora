import { Buffer } from 'buffer';
import { indexedDbKeyProvider } from '@/lib/encryptedLocalStore';
import type { NewRecordPayload } from '@/types';

export type OutboxStatus = 'pending' | 'syncing' | 'synced';

export interface ClinicalOutboxItem {
  id: string;
  status: OutboxStatus;
  createdAt: number;
  payload: NewRecordPayload;
}

interface StoredItem {
  id: string;
  ownerHash: string;
  status: OutboxStatus;
  createdAt: number;
  updatedAt: number;
  iv: string;
  ciphertext: string;
}

const DB_NAME = 'heliora-clinical-outbox';
const STORE_NAME = 'records';
const KEY_NAMESPACE = 'heliora-clinical-outbox';

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined')
    return Promise.reject(new Error('IndexedDB is unavailable.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function ownerHash(owner: string): Promise<string> {
  return crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(owner))
    .then((hash) => Buffer.from(new Uint8Array(hash)).toString('hex'));
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const request = action(tx.objectStore(STORE_NAME));
        tx.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        tx.onabort = () => {
          db.close();
          reject(request.error ?? tx.error);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

function aad(owner: string, id: string): ArrayBuffer {
  return new TextEncoder().encode(`${KEY_NAMESPACE}:${owner}:${id}`).buffer as ArrayBuffer;
}

async function encrypt(owner: string, id: string, payload: NewRecordPayload) {
  const key = await indexedDbKeyProvider.getKey(KEY_NAMESPACE);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer, additionalData: aad(owner, id) },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return {
    iv: Buffer.from(iv).toString('base64'),
    ciphertext: Buffer.from(new Uint8Array(ciphertext)).toString('base64'),
  };
}

async function decrypt(owner: string, item: StoredItem): Promise<NewRecordPayload> {
  const key = await indexedDbKeyProvider.getKey(KEY_NAMESPACE);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Uint8Array.from(Buffer.from(item.iv, 'base64')).buffer as ArrayBuffer,
      additionalData: aad(owner, item.id),
    },
    key,
    new Uint8Array(Buffer.from(item.ciphertext, 'base64')),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as NewRecordPayload;
}

export async function enqueueClinicalRecord(
  owner: string,
  payload: NewRecordPayload,
): Promise<string> {
  const id = crypto.randomUUID();
  const encrypted = await encrypt(owner, id, payload);
  const hash = await ownerHash(owner);
  const now = Date.now();
  await runTransaction('readwrite', (store) =>
    store.add({
      id,
      ownerHash: hash,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      ...encrypted,
    } satisfies StoredItem),
  );
  return id;
}

export async function listClinicalOutbox(owner: string): Promise<ClinicalOutboxItem[]> {
  const hash = await ownerHash(owner);
  const all = (await runTransaction('readonly', (store) => store.getAll())) as StoredItem[];
  const items = await Promise.all(
    all
      .filter((item) => item.ownerHash === hash)
      .map(async (item) => ({
        id: item.id,
        status: item.status === 'syncing' ? ('pending' as const) : item.status,
        createdAt: item.createdAt,
        payload: await decrypt(owner, item),
      })),
  );
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

export async function setClinicalOutboxStatus(id: string, status: OutboxStatus): Promise<void> {
  const item = (await runTransaction('readonly', (store) => store.get(id))) as
    StoredItem | undefined;
  if (!item) return;
  await runTransaction('readwrite', (store) =>
    store.put({ ...item, status, updatedAt: Date.now() }),
  );
}

export async function removeClinicalOutboxItem(id: string): Promise<void> {
  await runTransaction('readwrite', (store) => store.delete(id));
}
