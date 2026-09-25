export interface PreviewResult {
  headers: string[];
  mapped: Record<string, string>;
  unmapped: string[];
  missingRequired: string[];
  sampleRows: Record<string, string>[];
  totalRows: number;
}

export function HeaderMappingPreview({ preview }: { preview: PreviewResult }) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-700">
        <span className="font-medium">{preview.totalRows}</span> data rows detected · {preview.headers.length} columns
      </div>
      {preview.missingRequired.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          Missing required column(s): <strong>{preview.missingRequired.join(", ")}</strong>. Add them to the sheet and re-upload.
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase text-gray-500">Mapped columns</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Sheet header</th>
                <th>Maps to</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(preview.mapped).map(([h, k]) => (
                <tr key={h}>
                  <td>{h}</td>
                  <td>
                    <code className="rounded bg-gray-100 px-1 text-xs">{k}</code>
                  </td>
                </tr>
              ))}
              {Object.keys(preview.mapped).length === 0 && (
                <tr>
                  <td colSpan={2} className="text-gray-500">
                    No recognised columns
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase text-gray-500">Unmapped columns (kept as extra data)</h3>
          {preview.unmapped.length ? (
            <ul className="flex flex-wrap gap-1">
              {preview.unmapped.map((u) => (
                <li key={u} className="rounded bg-gray-100 px-2 py-0.5 text-xs">
                  {u}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-gray-500">None</p>
          )}
        </div>
      </div>
      {preview.sampleRows.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase text-gray-500">Sample rows</h3>
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="table">
              <thead>
                <tr>
                  {preview.headers.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sampleRows.map((row, i) => (
                  <tr key={i}>
                    {preview.headers.map((h) => (
                      <td key={h} className="max-w-[14rem] truncate">
                        {row[h] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
