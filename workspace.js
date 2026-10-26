// Workspace administration (cloud mode): members and roles, invitations,
// AI usage and the audit log. Every action is also enforced by the database.
const RANK = { viewer: 1, analyst: 2, admin: 3, owner: 4 };
const ROLE_HELP = {
  viewer: "Read-only access",
  analyst: "Add and edit risks and vendors, run AI",
  admin: "Analyst + manage members, view audit log",
  owner: "Admin + manage admins and owners, rename workspace",
};

export function initWorkspace({ $, escapeHtml: esc, toast, download, ctx, onRenamed, signOut }) {
  const { client, org, user } = ctx;
  const isAdmin = RANK[org.role] >= RANK.admin;
  const isOwner = org.role === "owner";
  let auditRows = [];

  $("#ws-settings").classList.remove("hidden");
  $("#ws-admin").classList.toggle("hidden", !isAdmin);
  $("#ws-name-input").value = org.name;
  $("#ws-name-input").disabled = !isOwner;
  $("#btn-ws-rename").classList.toggle("hidden", !isOwner);
  $("#ws-you").textContent = `${user.email} · ${org.role}`;
  $("#invite-role").innerHTML = ["viewer", "analyst", ...(isOwner ? ["admin"] : [])]
    .map((r) => `<option value="${r}" ${r === "analyst" ? "selected" : ""}>${r[0].toUpperCase() + r.slice(1)}</option>`).join("");

  const canManage = (role) => isOwner || (isAdmin && RANK[role] < RANK.admin);

  async function rpc(name, args, okMsg) {
    const { error } = await client.rpc(name, args);
    if (error) { toast(error.message, true); return false; }
    if (okMsg) toast(okMsg);
    return true;
  }

  async function loadUsage() {
    const { data } = await client.rpc("ai_quota", { org: org.id });
    const q = data?.[0];
    if (!q) return;
    const pct = q.monthly_limit ? Math.min(100, Math.round((q.used / q.monthly_limit) * 100)) : 100;
    $("#ws-usage").innerHTML = `<div class="usage-line"><span>${q.used} of ${q.monthly_limit} AI requests used this month</span>
      <div class="bar"><div class="${pct >= 90 ? "critical" : pct >= 70 ? "high" : ""}" style="width:${pct}%"></div></div></div>`;
  }

  async function loadMembers() {
    if (!isAdmin) return;
    const [{ data: members, error }, { data: invites }] = await Promise.all([
      client.from("memberships").select("user_id, email, role, created_at").eq("org_id", org.id).order("email"),
      client.from("invitations").select("id, email, role, expires_at").eq("org_id", org.id).is("accepted_at", null).order("created_at"),
    ]);
    if (error) return toast(error.message, true);
    $("#members-body").innerHTML = members.map((m) => {
      const self = m.user_id === user.id;
      const editable = !self && canManage(m.role);
      const options = Object.keys(RANK).filter((r) => isOwner || RANK[r] < RANK.admin);
      return `<tr>
        <td>${esc(m.email)}${self ? ' <span class="tag">you</span>' : ""}</td>
        <td>${editable
          ? `<select data-role-for="${esc(m.user_id)}">${options.map((r) => `<option ${r === m.role ? "selected" : ""}>${r}</option>`).join("")}</select>`
          : `<span title="${esc(ROLE_HELP[m.role])}">${esc(m.role)}</span>`}</td>
        <td>${esc(m.created_at.slice(0, 10))}</td>
        <td>${editable ? `<button class="small danger" data-remove-member="${esc(m.user_id)}" data-email="${esc(m.email)}">Remove</button>` : ""}</td>
      </tr>`;
    }).join("");
    $("#invites-body").innerHTML = (invites || []).map((i) => `<tr>
        <td>${esc(i.email)}</td><td>${esc(i.role)}</td><td>${esc(i.expires_at.slice(0, 10))}</td>
        <td><button class="small" data-revoke="${esc(i.id)}">Revoke</button></td></tr>`).join("")
      || `<tr><td colspan="4" class="muted">No pending invitations</td></tr>`;
  }

  async function loadAudit() {
    if (!isAdmin) return;
    const { data, error } = await client.from("audit_log")
      .select("at, actor_email, action, entity, entity_id, details").eq("org_id", org.id)
      .order("at", { ascending: false }).limit(200);
    if (error) return toast(error.message, true);
    auditRows = data;
    const label = { risks: "risk", vendors: "vendor", memberships: "member", invitations: "invitation", organizations: "workspace" };
    $("#audit-body").innerHTML = data.map((r) => `<tr>
        <td class="nowrap">${esc(new Date(r.at).toLocaleString())}</td>
        <td>${esc(r.actor_email || "system")}</td>
        <td>${esc(r.action)} ${esc(label[r.entity] || r.entity)} <strong>${esc(r.entity_id || "")}</strong>
          ${r.details?.changed?.length ? `<div class="small muted">changed: ${esc(r.details.changed.join(", "))}</div>` : ""}
          ${r.details?.role ? `<div class="small muted">role: ${esc(r.details.role)}</div>` : ""}</td></tr>`).join("")
      || `<tr><td colspan="3" class="muted">No activity yet</td></tr>`;
  }

  $("#members-body").addEventListener("change", async (e) => {
    const uid = e.target.dataset.roleFor;
    if (!uid) return;
    await rpc("set_member_role", { org: org.id, member: uid, new_role: e.target.value }, "Role updated");
    loadMembers(); loadAudit();
  });

  $("#members-body").addEventListener("click", async (e) => {
    const uid = e.target.dataset.removeMember;
    if (!uid || !confirm(`Remove ${e.target.dataset.email} from ${org.name}? They will lose access immediately.`)) return;
    await rpc("remove_member", { org: org.id, member: uid }, "Member removed");
    loadMembers(); loadAudit();
  });

  $("#invites-body").addEventListener("click", async (e) => {
    const id = e.target.dataset.revoke;
    if (!id) return;
    await rpc("revoke_invitation", { invitation: id }, "Invitation revoked");
    loadMembers();
  });

  $("#invite-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#invite-email").value.trim();
    if (await rpc("invite_member", { org: org.id, invitee_email: email, invitee_role: $("#invite-role").value })) {
      $("#invite-email").value = "";
      const link = `${location.origin}${location.pathname}`;
      $("#invite-result").innerHTML = `Invitation created for <strong>${esc(email)}</strong>. Send them this link: they join automatically once they create an account with that email and set up two-factor authentication.
        <code class="secret">${esc(link)}</code>`;
      loadMembers(); loadAudit();
    }
  });

  $("#btn-ws-rename").addEventListener("click", async () => {
    const name = $("#ws-name-input").value.trim();
    if (!name) return;
    const { error } = await client.from("organizations").update({ name }).eq("id", org.id);
    if (error) return toast(error.message, true);
    org.name = name;
    onRenamed(name);
    toast("Workspace renamed");
    loadAudit();
  });

  $("#btn-ws-leave").addEventListener("click", async () => {
    if (!confirm(`Leave ${org.name}? You'll lose access until someone invites you again.`)) return;
    if (await rpc("remove_member", { org: org.id, member: user.id })) signOut("You left the workspace.");
  });

  $("#btn-audit-export").addEventListener("click", () => {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = ["time,user,action,entity,id,details", ...auditRows.map((r) =>
      [r.at, r.actor_email, r.action, r.entity, r.entity_id, JSON.stringify(r.details || {})].map(cell).join(","))].join("\n");
    download(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv");
  });

  loadUsage(); loadMembers(); loadAudit();
  return { refreshUsage: loadUsage, refreshAudit: loadAudit };
}
