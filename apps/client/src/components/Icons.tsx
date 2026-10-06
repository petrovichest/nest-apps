import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export const PanelLeftIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="3.5" width="18" height="17" rx="4" />
    <path d="M9 3.5v17" />
  </Icon>
);

export const ArrowLeftIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m14.5 5.5-5.1 5.1a2 2 0 0 0 0 2.8l5.1 5.1" />
  </Icon>
);

export const ArrowRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m9.5 5.5 5.1 5.1a2 2 0 0 1 0 2.8l-5.1 5.1" />
  </Icon>
);

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="10.75" cy="10.75" r="6.75" />
    <path d="m16 16 4.25 4.25" />
  </Icon>
);

export const NewTaskIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m14.5 5 3.5 3.5M5 18.5l.8-4.3L16 4a2.5 2.5 0 0 1 3.5 3.5L9.3 17.7Z M13 20h7" />
  </Icon>
);

export const FolderIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 8a3 3 0 0 1 3-3h3.1c.8 0 1.5.3 2.1.9l1.2 1.2c.6.6 1.3.9 2.1.9H18a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z" />
  </Icon>
);

export const GitBranchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="6" cy="5.5" r="2.5" />
    <circle cx="6" cy="18.5" r="2.5" />
    <circle cx="18" cy="5.5" r="2.5" />
    <path d="M6 8v8M18 8a5 5 0 0 1-5 5H6" />
  </Icon>
);

export const MoreIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none" />
  </Icon>
);

export const RefreshIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 10a8.2 8.2 0 1 0-1.8 7M20 4v6h-6" />
  </Icon>
);

export const GripVerticalIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="9" cy="5.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="9" cy="18.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="5.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="18.5" r="1.2" fill="currentColor" stroke="none" />
  </Icon>
);

export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="8" y="8" width="12" height="12" rx="3" />
    <path d="M15.5 8V6.5A2.5 2.5 0 0 0 13 4H6.5A2.5 2.5 0 0 0 4 6.5V13a2.5 2.5 0 0 0 2.5 2.5H8" />
  </Icon>
);

export const EyeIcon = ({ crossed = false, ...props }: IconProps & { crossed?: boolean }) => (
  <Icon {...props}>
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.5" />
    {crossed && <path d="m4 4 16 16" />}
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m5 12 3.6 3.6a1.3 1.3 0 0 0 1.8 0L19 7" />
  </Icon>
);

export const ArrowUpIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 20V5M6 10l4.6-4.6a2 2 0 0 1 2.8 0L18 10" />
  </Icon>
);

export const ArrowDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4v15M6 14l4.6 4.6a2 2 0 0 0 2.8 0L18 14" />
  </Icon>
);

export const DownloadIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3v12m-5-5 5 5 5-5M5 17v3h14v-3" />
  </Icon>
);

export const GitHubIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 19c-4.3 1.3-4.3-2.2-6-2.7m12 5v-3.6c0-1 .1-1.6-.5-2.2 3.1-.4 6.3-1.5 6.3-6.9A5.4 5.4 0 0 0 19.3 5c.2-.8.2-2.4-.4-3.4 0 0-1.2-.4-3.9 1.4a13.5 13.5 0 0 0-7 0C5.3 1.2 4.1 1.6 4.1 1.6c-.6 1-.6 2.6-.4 3.4a5.4 5.4 0 0 0-1.5 3.6c0 5.4 3.2 6.5 6.3 6.9-.6.6-.5 1.2-.5 2.2v3.6" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const InfoIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5" />
    <circle cx="12" cy="7.7" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const BrowserIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="16" rx="4" />
    <path d="M3 9h18" />
    <circle cx="6.8" cy="6.6" r="0.6" fill="currentColor" stroke="none" />
    <circle cx="9.5" cy="6.6" r="0.6" fill="currentColor" stroke="none" />
  </Icon>
);

export const BellIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M18 9a6 6 0 0 0-12 0v2.5c0 1.9-.6 3.2-1.6 4.5a.9.9 0 0 0 .7 1.5h13.8a.9.9 0 0 0 .7-1.5c-1-1.3-1.6-2.6-1.6-4.5ZM10 21h4" />
  </Icon>
);

export const SlidersIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3.5 7h10M18.5 7h2M3.5 17h2M10.5 17h10" />
    <circle cx="16" cy="7" r="2.5" />
    <circle cx="8" cy="17" r="2.5" />
  </Icon>
);

export const SkillsIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4H8a3 3 0 0 0-3 3v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6M9 11h3M9 15h6" />
    <path d="M17 3c0 3-1 4-4 4 3 0 4 1 4 4 0-3 1-4 4-4-3 0-4-1-4-4Z" />
  </Icon>
);

export const ShieldIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3c2 1.5 4 2.5 7 3v5c0 4.5-2.7 7.8-7 10-4.3-2.2-7-5.5-7-10V6c3-.5 5-1.5 7-3Z M9 12l2 2 4-4" />
  </Icon>
);

export const ModelIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5.5" y="5.5" width="13" height="13" rx="4" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1.5" />
    <path d="M9 3v2.5M15 3v2.5M9 18.5V21M15 18.5V21M3 9h2.5M3 15h2.5M18.5 9H21M18.5 15H21" />
  </Icon>
);

export const PlanIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m3.5 6 1.5 1.5 2.5-3M11 6h9m-16.5 6L5 13.5l2.5-3M11 12h9m-16.5 6L5 19.5l2.5-3M11 18h9" />
  </Icon>
);

export const TeamIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="5.5" r="2.5" />
    <circle cx="5" cy="18" r="2.5" />
    <circle cx="19" cy="18" r="2.5" />
    <path d="M12 8v2.5M5 15.5V14a3.5 3.5 0 0 1 3.5-3.5h7A3.5 3.5 0 0 1 19 14v1.5" />
  </Icon>
);

export const TargetIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
  </Icon>
);

export const SendIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 19.5v-14M6 10.5l4.6-4.6a2 2 0 0 1 2.8 0l4.6 4.6" />
  </Icon>
);

export const MicrophoneIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="8.5" y="3" width="7" height="12" rx="3.5" />
    <path d="M5 11.5a7 7 0 0 0 14 0M12 18.5V21M9 21h6" />
  </Icon>
);

export const StopIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none" />
  </Icon>
);

export const XIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6.5 6.5 11 11m0-11-11 11" />
  </Icon>
);

export const PinIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 4h8M9 4v5a3 3 0 0 1-.6 1.8l-1.8 2.4A1.8 1.8 0 0 0 8 16h8a1.8 1.8 0 0 0 1.4-2.8l-1.8-2.4A3 3 0 0 1 15 9V4M12 16v5" />
  </Icon>
);

export const ArchiveIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="5" rx="2" />
    <path d="M5 9v8a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V9M10 13h4" />
  </Icon>
);

export const TrashIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.7 10.7a2.5 2.5 0 0 0 2.5 2.3h4.6a2.5 2.5 0 0 0 2.5-2.3L17.5 7M10 11v5M14 11v5" />
  </Icon>
);

export const PencilIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m14.5 5.5 4 4M4.5 19.5l1-4.5 10-10a2.8 2.8 0 0 1 4 4l-10 10Z" />
  </Icon>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6.5 9.5 4.1 4.1a2 2 0 0 0 2.8 0l4.1-4.1" />
  </Icon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m9.5 6.5 4.1 4.1a2 2 0 0 1 0 2.8l-4.1 4.1" />
  </Icon>
);

export const ServerIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="3" width="18" height="7" rx="3" />
    <rect x="3" y="14" width="18" height="7" rx="3" />
    <circle cx="7" cy="6.5" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="7" cy="17.5" r="0.9" fill="currentColor" stroke="none" />
    <path d="M16 6.5h1M16 17.5h1" />
  </Icon>
);

export const GaugeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5.6 18.4a9 9 0 1 1 12.8 0M12 12l4-4M5.5 12h1M7.5 6.5l.7.7M12 4.5v1M17.5 12h1" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
  </Icon>
);

export const ClockIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v4.2a1.5 1.5 0 0 0 .7 1.3l3.3 2" />
  </Icon>
);

export const TerminalIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="16" rx="4" />
    <path d="m7 9 2.3 2.3a1 1 0 0 1 0 1.4L7 15M13 15h4" />
  </Icon>
);

export const FileIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M13 3H8a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V9l-6-6Z M13 3v4a2 2 0 0 0 2 2h4" />
  </Icon>
);

export const ImageIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <circle cx="15.5" cy="8.5" r="1.5" />
    <path d="m3.5 16 4-4a2 2 0 0 1 2.8 0l8.3 8.3" />
  </Icon>
);

export const ToolIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 8.5a5.3 5.3 0 0 1-6.7 5.1L7 20a2.1 2.1 0 0 1-3-3l6.4-6.3A5.3 5.3 0 0 1 15.5 4l-2.4 2.4a1.4 1.4 0 0 0 0 2l2.5 2.5a1.4 1.4 0 0 0 2 0Z" />
  </Icon>
);

export const AlertIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m10.2 4.7-7 12.1A2 2 0 0 0 4.9 20h14.2a2 2 0 0 0 1.7-3.2l-7-12.1a2.1 2.1 0 0 0-3.6 0Z M12 9v4" />
    <circle cx="12" cy="16.5" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);
