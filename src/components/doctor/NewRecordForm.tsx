'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRecord, fetchRecords } from '@/services/api.service';
import DiagnosisCodeInput from './DiagnosisCodeInput';
import { checkMedicationInteractions } from '@/services/drugInteractionService';
import { useWalletStore } from '@/store/useWalletStore';
import { STELLAR_CONFIG } from '@/lib/stellar';
import { TransactionBuilder, Networks, Operation, Asset, Memo } from '@stellar/stellar-sdk';
import type { DiagnosisCode, MedicationCheckResult } from '@/types';
import { AlertTriangle, AlertOctagon, ShieldAlert, Info } from 'lucide-react';
import {
  enqueueClinicalRecord,
  listClinicalOutbox,
  removeClinicalOutboxItem,
  setClinicalOutboxStatus,
  type ClinicalOutboxItem,
} from '@/lib/clinicalOutbox';

interface Props {
  patientAddress: string;
  onSuccess: () => void;
  patientAllergies?: string[];
}

export default function NewRecordForm({ patientAddress, onSuccess, patientAllergies = [] }: Props) {
  const { publicKey } = useWalletStore();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    diagnosis: '',
    prescription: '',
    notes: '',
    overrideRationale: '',
    acknowledgeRisk: false,
  });
  const [dx, setDx] = useState<DiagnosisCode | null>(null);

  const [checkResult, setCheckResult] = useState<MedicationCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [outbox, setOutbox] = useState<ClinicalOutboxItem[]>([]);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [isSyncingOutbox, setIsSyncingOutbox] = useState(false);
  const syncingOutboxRef = useRef(false);

  const refreshOutbox = useCallback(async () => {
    if (!publicKey) return;
    try {
      setOutbox(await listClinicalOutbox(publicKey));
    } catch {
      // Keep the form usable if local storage is unavailable; queueing reports its own error.
    }
  }, [publicKey]);

  const syncOutbox = useCallback(async () => {
    if (!publicKey || !navigator.onLine || syncingOutboxRef.current) return;
    syncingOutboxRef.current = true;
    setIsSyncingOutbox(true);
    try {
      const pending = (await listClinicalOutbox(publicKey)).filter(
        (item) => item.status !== 'synced',
      );
      for (const item of pending) {
        await setClinicalOutboxStatus(item.id, 'syncing');
        await refreshOutbox();
        try {
          await createRecord(item.payload);
          await setClinicalOutboxStatus(item.id, 'synced');
          void queryClient.invalidateQueries({ queryKey: ['doctor-appointments'] });
          void queryClient.invalidateQueries({
            queryKey: ['patient-records', item.payload.patientAddress],
          });
        } catch {
          await setClinicalOutboxStatus(item.id, 'pending');
          break;
        }
      }
      await refreshOutbox();
    } finally {
      syncingOutboxRef.current = false;
      setIsSyncingOutbox(false);
    }
  }, [publicKey, queryClient, refreshOutbox]);

  useEffect(() => {
    void refreshOutbox();
    if (navigator.onLine) void syncOutbox();
    const handleOnline = () => {
      void syncOutbox();
    };
    const handleWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'heliora-sync-outbox') void syncOutbox();
    };
    window.addEventListener('online', handleOnline);
    navigator.serviceWorker?.addEventListener('message', handleWorkerMessage);
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker
        .register('/service-worker.js')
        .then(async (registration) => {
          const syncRegistration = registration as ServiceWorkerRegistration & {
            sync?: { register: (tag: string) => Promise<void> };
          };
          try {
            await syncRegistration.sync?.register('heliora-clinical-outbox');
          } catch {
            /* online event remains available */
          }
        })
        .catch(() => {
          /* unsupported or blocked; online event remains available */
        });
    }
    return () => {
      window.removeEventListener('online', handleOnline);
      navigator.serviceWorker?.removeEventListener('message', handleWorkerMessage);
    };
  }, [refreshOutbox, syncOutbox]);

  // Fetch patient medical records to extract active medications & allergies
  const { data: patientRecords } = useQuery({
    queryKey: ['patient-records', patientAddress],
    queryFn: () => fetchRecords(patientAddress),
    enabled: !!patientAddress,
  });

  // Extract active medications from history
  const activeMedications = useMemo(() => {
    if (!patientRecords) return [];
    const meds = new Set<string>();
    patientRecords.forEach((r) => {
      if (r.prescription) {
        r.prescription
          .split(/[,;\n]/)
          .map((m) => m.trim())
          .filter(Boolean)
          .forEach((m) => meds.add(m));
      }
    });
    return Array.from(meds);
  }, [patientRecords]);

  // Extract allergies from props and past medical notes
  const documentedAllergies = useMemo(() => {
    const list = new Set<string>(patientAllergies);
    if (patientRecords) {
      patientRecords.forEach((r) => {
        const text = `${r.diagnosis || ''} ${r.notes || ''}`.toLowerCase();
        if (text.includes('penicillin')) list.add('penicillin');
        if (text.includes('sulfa')) list.add('sulfa');
        if (text.includes('aspirin')) list.add('aspirin');
        if (text.includes('nsaid')) list.add('nsaids');
        if (text.includes('codeine') || text.includes('opioid')) list.add('opioids');
      });
    }
    return Array.from(list);
  }, [patientRecords, patientAllergies]);

  // Automatically cross-check proposed prescription
  useEffect(() => {
    let active = true;
    if (!form.prescription.trim()) {
      setCheckResult(null);
      return;
    }

    const timer = setTimeout(() => {
      void (async () => {
        setIsChecking(true);
        try {
          const result = await checkMedicationInteractions({
            proposedPrescription: form.prescription,
            activeMedications,
            allergies: documentedAllergies,
          });
          if (active) setCheckResult(result);
        } finally {
          if (active) setIsChecking(false);
        }
      })();
    }, 200);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [form.prescription, activeMedications, documentedAllergies]);

  const requiresOverride = !!(
    checkResult &&
    (checkResult.hasSevereContraindications || checkResult.hasAllergyConflicts)
  );

  const canSubmit =
    !requiresOverride ||
    (form.overrideRationale.trim().length >= 10 && form.acknowledgeRisk);

  const mutation = useMutation({
    mutationFn: async () => {
      if (requiresOverride && !canSubmit) {
        throw new Error('Physician override rationale and risk acknowledgment are required.');
      }

      const notesContent =
        form.overrideRationale.trim()
          ? `${form.notes ? form.notes + '\n\n' : ''}[PHYSICIAN CLINICAL OVERRIDE RATIONALE]: ${form.overrideRationale.trim()}`
          : form.notes;

      const payload = {
        patientAddress,
        diagnosis: form.diagnosis,
        prescription: form.prescription,
        notes: notesContent,
        ...(form.overrideRationale.trim()
          ? { overrideRationale: form.overrideRationale.trim() }
          : {}),
        ...(dx ? { diagnosisCode: dx } : {}),
      };

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (!publicKey)
          throw new Error('Connect the clinician wallet to securely queue this note.');
        await enqueueClinicalRecord(publicKey, payload);
        try {
          const registration = await navigator.serviceWorker?.ready;
          const syncRegistration = registration as
            | (ServiceWorkerRegistration & {
                sync?: { register: (tag: string) => Promise<void> };
              })
            | undefined;
          await syncRegistration?.sync?.register('heliora-clinical-outbox');
        } catch {
          /* The online event still syncs the queue when the app is open. */
        }
        return { queuedOffline: true as const };
      }

      const record = await createRecord(payload);

      // Build a minimal Stellar tx as on-chain proof
      if (window.freighter && publicKey) {
        const server = new (await import('@stellar/stellar-sdk')).Horizon.Server(
          STELLAR_CONFIG.horizonUrl,
        );
        const account = await server.loadAccount(publicKey);
        const tx = new TransactionBuilder(account, {
          fee: '100',
          networkPassphrase:
            STELLAR_CONFIG.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
        })
          .addOperation(
            Operation.payment({
              destination: patientAddress,
              asset: Asset.native(),
              amount: '0.0000001',
            }),
          )
          .addMemo(Memo.text(`record:${record.id}`))
          .setTimeout(30)
          .build();

        const signed = await window.freighter.signTransaction(tx.toXDR(), {
          networkPassphrase:
            STELLAR_CONFIG.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
        });
        const server2 = new (await import('@stellar/stellar-sdk')).Horizon.Server(
          STELLAR_CONFIG.horizonUrl,
        );
        await server2.submitTransaction(
          (await import('@stellar/stellar-sdk')).TransactionBuilder.fromXDR(
            signed,
            STELLAR_CONFIG.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
          ),
        );
      }

      return { queuedOffline: false as const, record };
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['doctor-appointments'] });
      void queryClient.invalidateQueries({ queryKey: ['patient-records', patientAddress] });
      void refreshOutbox();
      if (result.queuedOffline) setOutboxOpen(true);
      setForm({
        diagnosis: '',
        prescription: '',
        notes: '',
        overrideRationale: '',
        acknowledgeRisk: false,
      });
      setDx(null);
      setCheckResult(null);
      if (!result.queuedOffline) onSuccess();
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
      className="space-y-4"
    >
      <div>
        <label className="block text-xs font-medium text-text-2 mb-1">Diagnosis *</label>
        <DiagnosisCodeInput
          value={dx}
          onChange={(next) => {
            setDx(next);
            if (next) setForm((f) => ({ ...f, diagnosis: next.display }));
          }}
        />
        <input
          required
          value={form.diagnosis}
          onChange={(e) => {
            setDx(null); // free-text edits no longer match the picked code
            setForm((f) => ({ ...f, diagnosis: e.target.value }));
          }}
          placeholder="e.g. Acute Bacterial Sinusitis, Hypertension"
          className="mt-2 w-full rounded-md border border-border px-3 py-2 text-sm bg-surface-inset text-text-1 focus:outline-none focus:ring-2 focus:ring-border-focus"
        />
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            void refreshOutbox();
            setOutboxOpen(true);
          }}
          className="text-xs text-text-2 underline"
        >
          Clinical outbox ({outbox.filter((item) => item.status !== 'synced').length} pending)
        </button>
      </div>

      {outboxOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="clinical-outbox-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <section className="w-full max-w-lg rounded-lg bg-surface-card p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 id="clinical-outbox-title" className="text-base font-semibold">
                Clinical outbox
              </h2>
              <button
                type="button"
                onClick={() => setOutboxOpen(false)}
                aria-label="Close outbox"
                className="text-sm"
              >
                Close
              </button>
            </div>
            {outbox.length === 0 ? (
              <p className="text-sm text-text-2">No queued clinical notes.</p>
            ) : (
              <ul className="max-h-72 space-y-3 overflow-y-auto">
                {outbox.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-3 rounded border border-border p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{item.payload.diagnosis}</p>
                      <p className="text-xs text-text-2">
                        {new Date(item.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <span className="text-xs capitalize">{item.status}</span>
                    {item.status === 'synced' && (
                      <button
                        type="button"
                        onClick={async () => {
                          await removeClinicalOutboxItem(item.id);
                          await refreshOutbox();
                        }}
                        className="text-xs underline"
                      >
                        Dismiss
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                disabled={!navigator.onLine || isSyncingOutbox}
                onClick={() => {
                  void syncOutbox();
                }}
                className="rounded bg-green px-3 py-2 text-sm font-medium disabled:opacity-50"
              >
                {isSyncingOutbox ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
          </section>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-xs font-medium text-text-2">Prescription</label>
          {isChecking && <span className="text-2xs text-text-3">Cross-checking interactions…</span>}
        </div>
        <input
          value={form.prescription}
          onChange={(e) => setForm((f) => ({ ...f, prescription: e.target.value }))}
          placeholder="e.g. Amoxicillin 500mg TID, Warfarin 5mg, Ibuprofen 600mg"
          className="w-full rounded-md border border-border px-3 py-2 text-sm bg-surface-inset text-text-1 focus:outline-none focus:ring-2 focus:ring-border-focus"
        />

        {/* Patient Profile Context Badge */}
        {(activeMedications.length > 0 || documentedAllergies.length > 0) && (
          <div className="mt-1.5 flex flex-wrap gap-2 text-2xs text-text-3">
            {activeMedications.length > 0 && (
              <span className="inline-flex items-center gap-1 bg-surface-card px-2 py-0.5 rounded border border-border">
                <Info className="w-3 h-3 text-text-2" />
                Active Meds: {activeMedications.slice(0, 3).join(', ')}
                {activeMedications.length > 3 && ` +${activeMedications.length - 3} more`}
              </span>
            )}
            {documentedAllergies.length > 0 && (
              <span className="inline-flex items-center gap-1 bg-red-50 text-red-700 px-2 py-0.5 rounded border border-red-200 font-medium">
                <ShieldAlert className="w-3 h-3 text-red-600" />
                Documented Allergies: {documentedAllergies.join(', ')}
              </span>
            )}
          </div>
        )}
      </div>

      {/* High-Visibility Medication & Allergy Conflict Warnings Banner */}
      {checkResult && checkResult.hasConflicts && (
        <div
          className={`rounded-lg border p-4 space-y-3 ${
            requiresOverride
              ? 'bg-red-50 border-red-300 text-red-950'
              : 'bg-amber-50 border-amber-300 text-amber-950'
          }`}
          role="alert"
          aria-live="assertive"
        >
          <div className="flex items-center gap-2">
            {requiresOverride ? (
              <AlertOctagon className="w-5 h-5 text-red-600 shrink-0" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            )}
            <h4 className="font-bold text-sm">
              {requiresOverride
                ? 'CRITICAL CONTRAINDICATION & ALLERGY CONFLICT WARNING'
                : 'Medication Interaction Alert'}
            </h4>
          </div>

          <div className="space-y-2">
            {checkResult.conflicts.map((conflict) => (
              <div
                key={conflict.id}
                className="rounded-md bg-white/80 p-2.5 border border-black/5 text-xs space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-slate-900">{conflict.title}</span>
                  <span
                    className={`px-2 py-0.5 rounded text-2xs font-extrabold uppercase tracking-wide ${
                      conflict.severity === 'severe'
                        ? 'bg-red-600 text-white'
                        : 'bg-amber-500 text-white'
                    }`}
                  >
                    {conflict.type === 'allergy_conflict' ? 'Allergy Conflict' : `${conflict.severity} Risk`}
                  </span>
                </div>
                <p className="text-slate-700">{conflict.description}</p>
                <div className="text-2xs text-slate-500">
                  <span className="font-semibold">Conflict:</span> {conflict.drug} ⚡{' '}
                  <span className="font-medium underline">{conflict.conflictingWith}</span>
                </div>
                {conflict.recommendation && (
                  <p className="text-2xs font-medium text-slate-800 bg-slate-100 p-1.5 rounded">
                    💡 Clinical Guidance: {conflict.recommendation}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Mandatory Override Rationale for severe contraindications */}
          {requiresOverride && (
            <div className="pt-2 border-t border-red-200 space-y-2">
              <label className="block text-xs font-bold text-red-900">
                Prescribing Physician Override Rationale *
              </label>
              <textarea
                required
                rows={2}
                value={form.overrideRationale}
                onChange={(e) => setForm((f) => ({ ...f, overrideRationale: e.target.value }))}
                placeholder="State clinical justification, laboratory safeguards, or mitigation strategy to proceed despite contraindication…"
                className="w-full rounded-md border border-red-300 bg-white px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-500"
              />
              <label className="flex items-start gap-2 text-xs text-red-900 font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.acknowledgeRisk}
                  onChange={(e) => setForm((f) => ({ ...f, acknowledgeRisk: e.target.checked }))}
                  className="mt-0.5 rounded border-red-300 text-red-600 focus:ring-red-500"
                />
                <span>
                  I acknowledge the contraindication / allergen conflict risks and affirm that clinical benefit outweighs potential harm.
                </span>
              </label>
            </div>
          )}
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-text-2 mb-1">Notes</label>
        <textarea
          rows={3}
          value={form.notes}
          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          placeholder="Additional clinical observations, follow-up instructions…"
          className="w-full rounded-md border border-border px-3 py-2 text-sm bg-surface-inset text-text-1 focus:outline-none focus:ring-2 focus:ring-border-focus"
        />
      </div>

      {mutation.isError && (
        <p className="text-xs text-red-600">Failed to submit record. Please check inputs and retry.</p>
      )}

      <button
        type="submit"
        disabled={mutation.isPending || (requiresOverride && !canSubmit)}
        className="w-full rounded-md bg-green py-2.5 text-sm font-semibold text-[#030D09] hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {mutation.isPending
          ? 'Submitting…'
          : requiresOverride
            ? 'Submit With Clinical Override'
            : 'Submit Record'}
      </button>
    </form>
  );
}
