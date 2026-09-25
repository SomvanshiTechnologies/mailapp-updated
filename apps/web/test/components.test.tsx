import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { StatusBadge } from "../src/components/StatusBadge";
import { HeaderMappingPreview } from "../src/components/HeaderMappingPreview";
import { SequenceEditor, validateSequence } from "../src/components/SequenceEditor";
import { DEFAULT_SEQUENCE, type SequenceStep } from "@mailapp/shared";

describe("StatusBadge", () => {
  it("renders a readable label with a tone class", () => {
    render(<StatusBadge status="pending_review" />);
    const el = screen.getByText(/pending review/i);
    expect(el.className).toMatch(/amber/);
  });
});

describe("HeaderMappingPreview", () => {
  it("shows mapped, unmapped and missing-required columns", () => {
    render(
      <HeaderMappingPreview
        preview={{
          headers: ["Name", "Company", "Owner"],
          mapped: { Name: "first_name", Company: "company" },
          unmapped: ["Owner"],
          missingRequired: ["email"],
          sampleRows: [{ Name: "Ann", Company: "Acme", Owner: "sam" }],
          totalRows: 1,
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("email");
    expect(screen.getByText("first_name")).toBeInTheDocument();
    expect(screen.getAllByText("Owner").length).toBeGreaterThan(0);
  });
});

function Harness({ initial, onChange }: { initial: SequenceStep[]; onChange?: (v: SequenceStep[]) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <SequenceEditor
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

describe("SequenceEditor", () => {
  it("validates with the shared schema", () => {
    expect(validateSequence(DEFAULT_SEQUENCE)).toEqual([]);
    expect(validateSequence([{ step: 1, delayDays: 2, guidance: "", threaded: true }]).join(" ")).toMatch(/delayDays = 0/);
    expect(validateSequence([]).length).toBeGreaterThan(0);
  });

  it("adds and removes steps with renumbering", () => {
    const onChange = vi.fn();
    render(<Harness initial={DEFAULT_SEQUENCE} onChange={onChange} />);
    expect(screen.getAllByTestId(/seq-step-/)).toHaveLength(3);
    fireEvent.click(screen.getAllByRole("button", { name: /remove/i })[0]);
    const last = onChange.mock.calls.at(-1)![0] as SequenceStep[];
    expect(last.map((s) => s.step)).toEqual([1, 2]);
    expect(last[0].delayDays).toBe(0);
    fireEvent.change(screen.getByLabelText("Step 2 delay days"), { target: { value: "7" } });
    expect((onChange.mock.calls.at(-1)![0] as SequenceStep[])[1].delayDays).toBe(7);
  });
});
