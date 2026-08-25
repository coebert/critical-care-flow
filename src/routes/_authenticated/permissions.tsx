import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/permissions")({
  head: () => ({
    meta: [
      { title: "Role & Permission Matrix — SDH Critical Care" },
      {
        name: "description",
        content:
          "Reference matrix of read, write, and administer permissions for each referral-related table, by clinician role.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  beforeLoad: async () => {
    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id;
    if (!uid) throw redirect({ to: "/auth", search: {} });
    const { data: isAdmin } = await supabase.rpc("has_role", {
      _user_id: uid,
      _role: "admin",
    });
    if (!isAdmin) throw redirect({ to: "/" });
  },
  component: PermissionsPage,
});

// Roles displayed as columns. "Clinician" = any user with the `clinician` or
// `admin` role (i.e. `has_clinical_access`). "Author/Creator" is a
// clinician acting on a row they created. "Recipient" is a clinician a note
// was addressed to. "Admin" implies clinical access.
type Role = "author" | "clinician" | "recipient" | "admin" | "anon";

type Cell =
  | { kind: "allow"; note?: string }
  | { kind: "deny"; note?: string }
  | { kind: "na" };

interface Op {
  op: "SELECT" | "INSERT" | "UPDATE" | "DELETE";
  by: Partial<Record<Role, Cell>>;
  policy: string;
}

interface TableRow {
  table: string;
  purpose: string;
  ops: Op[];
}

// Source of truth: mirrors the SQL policies currently on each table.
// Update this file when policies change.
const MATRIX: TableRow[] = [
  {
    table: "referrals",
    purpose: "Referral records for critical-care admissions.",
    ops: [
      {
        op: "SELECT",
        policy:
          "Clinical staff read all live rows; creators and admins additionally see their soft-deleted rows.",
        by: {
          author: { kind: "allow", note: "Including own soft-deleted" },
          clinician: { kind: "allow", note: "Live rows only" },
          recipient: { kind: "na" },
          admin: { kind: "allow", note: "All rows incl. soft-deleted" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "INSERT",
        policy: "Clinical staff, must set created_by = self.",
        by: {
          author: { kind: "allow" },
          clinician: { kind: "allow" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "UPDATE",
        policy:
          "Live-row edits: any clinical staff. Soft-delete/restore: creator or admin only (enforced by policy + trigger).",
        by: {
          author: { kind: "allow" },
          clinician: { kind: "allow", note: "Live edits; not delete/restore" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "DELETE",
        policy:
          "Hard delete allowed only to creator or admin (application uses soft-delete).",
        by: {
          author: { kind: "allow" },
          clinician: { kind: "deny" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
    ],
  },
  {
    table: "referral_notes",
    purpose: "End-to-end-encrypted notes attached to a referral.",
    ops: [
      {
        op: "SELECT",
        policy: "Any user with clinical access can read note metadata + ciphertext.",
        by: {
          author: { kind: "allow" },
          clinician: { kind: "allow" },
          recipient: { kind: "allow", note: "Decrypts via own wrapped key" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "INSERT",
        policy: "Clinical staff, must set author_id = self.",
        by: {
          author: { kind: "allow" },
          clinician: { kind: "allow" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "UPDATE",
        policy: "Author or admin, provided the caller has clinical access.",
        by: {
          author: { kind: "allow" },
          clinician: { kind: "deny", note: "Not the author" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "DELETE",
        policy: "Author or admin.",
        by: {
          author: { kind: "allow" },
          clinician: { kind: "deny" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
    ],
  },
  {
    table: "referral_note_keys",
    purpose:
      "Per-recipient wrapped content keys (sealed-box) for each encrypted note.",
    ops: [
      {
        op: "SELECT",
        policy:
          "Recipient reads own key row; note author reads all rows on their note; admin reads all.",
        by: {
          author: { kind: "allow", note: "All rows on own notes" },
          clinician: { kind: "deny", note: "Unless recipient" },
          recipient: { kind: "allow", note: "Own key row only" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "INSERT",
        policy: "Note author or admin (admin path re-wraps keys on edit).",
        by: {
          author: { kind: "allow" },
          clinician: { kind: "deny" },
          recipient: { kind: "deny" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "DELETE",
        policy: "Note author or admin (used during key rotation on edit).",
        by: {
          author: { kind: "allow" },
          clinician: { kind: "deny" },
          recipient: { kind: "deny" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
    ],
  },
  {
    table: "notifications",
    purpose: "Per-user in-app notifications about referrals and notes.",
    ops: [
      {
        op: "SELECT",
        policy: "Owner only (user_id = auth.uid()).",
        by: {
          author: { kind: "allow", note: "Only own notifications" },
          clinician: { kind: "allow", note: "Only own notifications" },
          admin: { kind: "allow", note: "Only own notifications" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "INSERT",
        policy: "Admin only (fan-out is performed by server functions).",
        by: {
          author: { kind: "deny" },
          clinician: { kind: "deny" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "UPDATE",
        policy:
          "Owner only, and only the read_at field (immutable-field trigger blocks the rest).",
        by: {
          author: { kind: "allow", note: "read_at only" },
          clinician: { kind: "allow", note: "read_at only" },
          admin: { kind: "allow", note: "read_at only" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "DELETE",
        policy: "Admin only.",
        by: {
          author: { kind: "deny" },
          clinician: { kind: "deny" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
    ],
  },
  {
    table: "audit_log",
    purpose: "Append-only record of admin/security-relevant actions.",
    ops: [
      {
        op: "SELECT",
        policy: "Admin only.",
        by: {
          author: { kind: "deny" },
          clinician: { kind: "deny" },
          admin: { kind: "allow" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "INSERT",
        policy: "Written server-side only (service role); no client policy.",
        by: {
          author: { kind: "deny" },
          clinician: { kind: "deny" },
          admin: { kind: "deny", note: "Server-only writes" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "UPDATE",
        policy: "Not permitted (append-only).",
        by: {
          author: { kind: "deny" },
          clinician: { kind: "deny" },
          admin: { kind: "deny" },
          anon: { kind: "deny" },
        },
      },
      {
        op: "DELETE",
        policy: "Not permitted (append-only).",
        by: {
          author: { kind: "deny" },
          clinician: { kind: "deny" },
          admin: { kind: "deny" },
          anon: { kind: "deny" },
        },
      },
    ],
  },
];

const ROLE_ORDER: { key: Role; label: string; hint: string }[] = [
  { key: "author", label: "Author / Creator", hint: "Clinician who created the row" },
  { key: "clinician", label: "Other clinician", hint: "Any user with clinical access" },
  { key: "recipient", label: "Note recipient", hint: "Clinician addressed by a note" },
  { key: "admin", label: "Admin", hint: "Users with the admin role" },
  { key: "anon", label: "Signed-out", hint: "Unauthenticated (anon)" },
];

function CellView({ cell }: { cell: Cell | undefined }) {
  if (!cell || cell.kind === "na") {
    return <span className="text-muted-foreground">—</span>;
  }
  if (cell.kind === "allow") {
    return (
      <div className="flex flex-col items-start gap-1">
        <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white">Allow</Badge>
        {cell.note && (
          <span className="text-xs text-muted-foreground leading-tight">{cell.note}</span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant="destructive">Deny</Badge>
      {cell.note && (
        <span className="text-xs text-muted-foreground leading-tight">{cell.note}</span>
      )}
    </div>
  );
}

function PermissionsPage() {
  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Role &amp; Permission Matrix
        </h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          Reference for the row-level security policies enforced by the
          database on referral-related tables. Server functions apply the
          same rules and add stricter application-layer checks (e.g. admin
          self-demotion guard, encrypted-note recipient coverage). Update
          this page in the same change as any policy migration.
        </p>
        <div className="text-sm">
          <Link to="/admin" className="text-primary hover:underline">
            ← Back to Admin
          </Link>
        </div>
      </header>

      <Card className="p-4">
        <h2 className="font-medium mb-2">Roles</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          {ROLE_ORDER.map((r) => (
            <div key={r.key}>
              <dt className="font-medium">{r.label}</dt>
              <dd className="text-muted-foreground">{r.hint}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {MATRIX.map((row) => (
        <Card key={row.table} className="p-4 overflow-x-auto">
          <div className="mb-3">
            <h2 className="font-mono text-base font-semibold">{row.table}</h2>
            <p className="text-sm text-muted-foreground">{row.purpose}</p>
          </div>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b">
                <th className="text-left font-medium py-2 pr-3 w-24">Op</th>
                {ROLE_ORDER.map((r) => (
                  <th key={r.key} className="text-left font-medium py-2 pr-3">
                    {r.label}
                  </th>
                ))}
                <th className="text-left font-medium py-2 pl-3">Policy</th>
              </tr>
            </thead>
            <tbody>
              {row.ops.map((op) => (
                <tr key={op.op} className="border-b last:border-0 align-top">
                  <td className="py-3 pr-3 font-mono">{op.op}</td>
                  {ROLE_ORDER.map((r) => (
                    <td key={r.key} className="py-3 pr-3">
                      <CellView cell={op.by[r.key]} />
                    </td>
                  ))}
                  <td className="py-3 pl-3 text-muted-foreground max-w-xs">
                    {op.policy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}
