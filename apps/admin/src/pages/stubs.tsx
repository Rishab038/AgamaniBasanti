// Phase 2-3 pages — placeholders so navigation and routing are in
// place. Each grows into its full module per docs/ARCHITECTURE.md.

function Stub({ title, note }: { title: string; note: string }) {
  return (
    <div>
      <h1>{title}</h1>
      <p className="muted">{note}</p>
    </div>
  );
}

export const Staff = () => (
  <Stub title="Staff" note="Phase 2: add/edit staff, assign shifts, register devices and fingerprint enrollment numbers." />
);
export const Attendance = () => (
  <Stub title="Attendance" note="Phase 2: calendar view, approve single-verification days, CSV/PDF export." />
);
export const Advances = () => (
  <Stub title="Advances" note="Phase 3: approve requests, view running balances and recovery schedule." />
);
export const Payroll = () => (
  <Stub title="Payroll" note="Phase 3: run month-end payroll, review, confirm, and export payslips." />
);
export const Settings = () => (
  <Stub title="Settings" note="Phase 2: geofence coordinates and radius, shop Wi-Fi, shifts, leave policy, holidays." />
);
