/**
 * Who may do what. Four roles in a simple ladder; every check in the dashboard goes through `can()` so the rules live
 * in exactly one place (and the Team page prints this same table, so what clients read is what the code enforces).
 */

export const ROLES = ['viewer', 'staff', 'manager', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

export const PERMISSIONS = [
  'overview.view',
  'enquiries.view',
  'enquiries.annotate',
  'customers.create',
  'enquiries.export',
  'status.view',
  'team.view',
  'team.manage',
  'alerts.manage',
  'activity.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface RoleInfo {
  label: string;
  /** Higher = more senior. Used for "may this person manage that person". */
  rank: number;
  /** One plain sentence for the Team page and the sign-in hint. */
  blurb: string;
  can: ReadonlySet<Permission>;
}

const set = (...p: Permission[]): ReadonlySet<Permission> => new Set(p);

export const ROLE_INFO: Readonly<Record<Role, RoleInfo>> = {
  viewer: {
    label: 'Viewer',
    rank: 1,
    blurb: 'Looks but does not change anything. For directors and anyone who just wants to see how it is going.',
    can: set('overview.view', 'enquiries.view'),
  },
  staff: {
    label: 'Staff',
    rank: 2,
    blurb: 'Works the enquiries. Adds notes, marks items handled, and adds new customers to Zoho Books after checking their details.',
    can: set('overview.view', 'enquiries.view', 'enquiries.annotate', 'customers.create'),
  },
  manager: {
    label: 'Manager',
    rank: 3,
    blurb: 'Looks after the desk. Also sees system status, downloads enquiry lists, and adds or removes staff and viewers.',
    can: set('overview.view', 'enquiries.view', 'enquiries.annotate', 'customers.create', 'enquiries.export', 'status.view', 'team.view', 'team.manage'),
  },
  owner: {
    label: 'Owner',
    rank: 4,
    blurb: 'Runs the account. Everything a manager can do, plus managers and other owners, who receives the alert emails, and the activity log.',
    can: set(...PERMISSIONS),
  },
};

/** What each permission means in words, for the "what each role can do" table. */
export const PERMISSION_TEXT: Readonly<Record<Permission, string>> = {
  'overview.view': 'See the overview and charts',
  'enquiries.view': 'Open enquiries and their step-by-step trail',
  'enquiries.annotate': 'Add notes and mark enquiries handled',
  'customers.create': 'Add a new customer to Zoho Books (after checking the details)',
  'enquiries.export': 'Download an enquiry list (CSV)',
  'status.view': 'See system status and settings',
  'team.view': 'See who has a login',
  'team.manage': 'Add people, change roles, reset passwords',
  'alerts.manage': 'Choose which email addresses receive the alerts (Sales and stakeholders)',
  'activity.view': 'See the sign-in and changes log',
};

export const can = (role: Role, permission: Permission): boolean => ROLE_INFO[role].can.has(permission);

export const roleLabel = (role: Role): string => ROLE_INFO[role].label;

/**
 * Hierarchy: owners manage everyone; managers manage staff and viewers; nobody else manages anybody. Nobody changes
 * their own role or access (an owner who needs to step down asks another owner).
 */
export function canManage(actor: Role, target: Role): boolean {
  if (actor === 'owner') return true;
  return can(actor, 'team.manage') && ROLE_INFO[actor].rank > ROLE_INFO[target].rank;
}

/** Roles this person may give to someone. */
export function assignableRoles(actor: Role): Role[] {
  return ROLES.filter((r) => canManage(actor, r)).reverse();
}
