import { L } from '../../i18n/i18n';
import type { CountEntry, Product, Session } from '../../db/db';
import type { Movement } from '../../db/movements';
import type { ReportRow } from '../../report';
import type { CloudRoomState, LiveScannerState } from '../../sync/cloudSync';
import { fmtDateTime } from '../dom';

export type SupervisorTab = 'techs' | 'feed' | 'matrix' | 'sessions';
export type FeedFilter = 'all' | 'counts' | 'movements';
export type MatrixFilter = 'all' | 'alerts' | 'diff' | 'counted' | 'pending';

export interface TechSummary {
  name: string;
  scans: number;
  units: number;
  movementsCount: number;
  lastSeen: number;
  lastActionLabel: string;
  skusTouched: Set<string>;
  liveScanner?: LiveScannerState;
}

export interface TeamDashboardData {
  sessions: Session[];
  current: Session | undefined;
  deviceId: string;
  roomState: CloudRoomState | null;
  products: Product[];
  curCounts: CountEntry[];
  movements: Movement[];
  idealLevels: Record<string, number>;
  reportLines: ReportRow[];
  prodByBarcode: Map<string, Product>;
  prodBySku: Map<string, Product>;
  activeLiveScanners: LiveScannerState[];
  techList: TechSummary[];
  activeNowCount: number;
  totalCatalogSkus: number;
  countedSkusCount: number;
  progressPct: number;
  totalUnitsCounted: number;
  totalInUnits: number;
  totalOutUnits: number;
  criticalCount: number;
  deficitCount: number;
  alertSkusCount: number;
  hasLiveRoomData: boolean;
}

export function fmtRelativeAgo(ts: number | null | undefined): string {
  if (!ts) return L('Sin actividad', 'No activity');
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 5) return L('Justo ahora', 'Just now');
  if (diffSec < 60) return L(`Hace ${diffSec} s`, `${diffSec}s ago`);
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return L(`Hace ${mins} min`, `${mins}m ago`);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return L(`Hace ${hrs} h`, `${hrs}h ago`);
  return fmtDateTime(ts);
}
