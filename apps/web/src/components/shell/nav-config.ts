import {
  Activity,
  BarChart3,
  CalendarCheck,
  CalendarRange,
  ClipboardList,
  FileUp,
  GraduationCap,
  LayoutDashboard,
  type LucideIcon,
  MessageSquare,
  Settings,
  ShieldCheck,
  UserRoundCheck,
  Users,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /**
   * Permission key required to see this item, e.g. "access.role:read". Left
   * unset for items with no access-controlled backing yet - the server is
   * the real gate for those routes regardless of what the sidebar shows.
   * When set, the sidebar hides (never disables) the item for a user who
   * lacks it - see usePermissions() for why hiding is UX only, not security.
   */
  permission?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const navGroups: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'School',
    items: [
      { label: 'People', href: '/people', icon: Users, permission: 'people.person:read' },
      {
        label: 'Enrollment',
        href: '/enrollment',
        icon: UserRoundCheck,
        permission: 'enrollment.enrollment:read',
      },
      { label: 'Academics', href: '/academics', icon: GraduationCap },
      {
        label: 'Attendance',
        href: '/attendance',
        icon: CalendarCheck,
        permission: 'attendance.record:read',
      },
      {
        label: 'Timetable',
        href: '/timetable',
        icon: CalendarRange,
        permission: 'academic.timetable:read',
      },
      {
        label: 'Gradebook',
        href: '/gradebook',
        icon: ClipboardList,
        permission: 'academic.gradebook:read',
      },
      { label: 'Communications', href: '/communications', icon: MessageSquare },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Reports', href: '/reports', icon: BarChart3 },
      { label: 'Settings', href: '/settings', icon: Settings },
      {
        label: 'Roles & permissions',
        href: '/settings/roles',
        icon: ShieldCheck,
        permission: 'access.role:read',
      },
      {
        label: 'Import',
        href: '/settings/import',
        icon: FileUp,
        // The import endpoints are gated on people.person:read/:write (see
        // ImportExportController's own doc comment - no dedicated
        // import.job:* permission pair exists yet), so this mirrors that
        // rather than inventing a permission key the server doesn't check.
        permission: 'people.person:write',
      },
      { label: 'System', href: '/system', icon: Activity },
    ],
  },
];
