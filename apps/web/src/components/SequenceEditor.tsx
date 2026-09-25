import { useMemo } from "react";
import { SequenceSchema, type SequenceStep } from "@mailapp/shared";

export function validateSequence(steps: SequenceStep[]): string[] {
  const r = SequenceSchema.safeParse(steps);
  if (r.success) return [];
  return r.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
}

export function SequenceEditor({
  value,
  onChange,
  disabled,
}: {
  value: SequenceStep[];
  onChange: (v: SequenceStep[]) => void;
  disabled?: boolean;
}) {
  const errors = useMemo(() => validateSequence(value), [value]);
  const update = (i: number, patch: Partial<SequenceStep>) => {
    onChange(value.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };
  const renumber = (steps: SequenceStep[]) => steps.map((s, i) => ({ ...s, step: i + 1, delayDays: i === 0 ? 0 : s.delayDays }));
  const addStep = () =>
    onChange(renumber([...value, { step: value.length + 1, delayDays: 3, guidance: "", threaded: true }]));
  const remove = (i: number) => onChange(renumber(value.filter((_, idx) => idx !== i)));

  return (
    <div className="space-y-3">
      {value.map((s, i) => (
        <div key={i} className="rounded-md border border-gray-200 p-3" data-testid={`seq-step-${s.step}`}>
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">Step {s.step}{i === 0 ? " (initial email)" : ""}</div>
            {!disabled && value.length > 1 && (
              <button type="button" className="btn-ghost btn-sm text-red-600" onClick={() => remove(i)}>
                Remove
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[10rem_1fr_8rem]">
            <div>
              <label className="label">Delay (days after previous)</label>
              <input
                type="number"
                min={0}
                max={90}
                className="input"
                aria-label={`Step ${s.step} delay days`}
                value={s.delayDays}
                disabled={disabled || i === 0}
                onChange={(e) => update(i, { delayDays: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="label">Guidance for the LLM</label>
              <textarea
                className="input"
                rows={2}
                aria-label={`Step ${s.step} guidance`}
                value={s.guidance}
                disabled={disabled}
                onChange={(e) => update(i, { guidance: e.target.value })}
              />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={s.threaded} disabled={disabled} onChange={(e) => update(i, { threaded: e.target.checked })} />
                Threaded
              </label>
            </div>
          </div>
        </div>
      ))}
      {!disabled && (
        <button type="button" className="btn-secondary btn-sm" onClick={addStep} disabled={value.length >= 8}>
          + Add follow-up step
        </button>
      )}
      {errors.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-red-600" data-testid="sequence-errors">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
