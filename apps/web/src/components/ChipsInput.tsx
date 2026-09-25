import { useState } from "react";

export function ChipsInput({
  value,
  onChange,
  placeholder = "Type and press Enter",
  disabled,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (!value.includes(v)) onChange([...value, v]);
    setDraft("");
  };
  return (
    <div className={"flex flex-wrap items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 " + (disabled ? "bg-gray-100" : "")}>
      {value.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs">
          {v}
          {!disabled && (
            <button type="button" aria-label={`Remove ${v}`} className="text-gray-500 hover:text-gray-900" onClick={() => onChange(value.filter((x) => x !== v))}>
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          className="min-w-[8rem] flex-1 border-0 px-1 py-0.5 text-sm focus:outline-none"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={add}
        />
      )}
    </div>
  );
}
