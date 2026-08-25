/**
 * PRE-R1 Control Plane data access.
 *
 * Production mode reads ONLY real Control Plane records through the
 * approved RLS (operators read tenants/alerts/releases/audit logs).
 * Sample/demo data is confined to DEV preview mode and can never
 * masquerade as real customers in production.
 */
import { useEffect, useState } from 'react';
import { getSupabaseClient } from './supabase';
import { sampleTenants } from './mockData';

export interface RealTenantRow {
  id: string;
  companyName: string;
  slug: string;
  exactSubdomain: string;
  status: string;
  createdAt: string;
}

export interface RealAuditRow {
  id: number;
  action: string;
  entityType: string;
  entityId: string;
  actorLabel: string;
  createdAt: string;
}

export interface RealReleaseRow {
  id: string;
  version: string;
  gitSha: string | null;
  artifactSha256: string | null;
  createdAt: string;
}

export interface RealAlertRow {
  id: string;
  tenantId: string | null;
  severity: string;
  code: string;
  createdAt: string;
}

export interface ControlPlaneData {
  loading: boolean;
  tenants: RealTenantRow[];
  auditEvents: RealAuditRow[];
  releases: RealReleaseRow[];
  alerts: RealAlertRow[];
}

const EMPTY: ControlPlaneData = { loading: false, tenants: [], auditEvents: [], releases: [], alerts: [] };

/**
 * `productionMode` = true only inside an authorized operator session.
 * When Supabase is not configured the hook returns empty real data
 * (never sample data) so production UI cannot show fake customers.
 */
export function useControlPlaneData(productionMode: boolean): ControlPlaneData {
  const [data, setData] = useState<ControlPlaneData>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!productionMode) {
      setData(EMPTY);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    const client = getSupabaseClient();
    if (!client) {
      setData(EMPTY);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    (async () => {
      const tenants = await client
        .from('tenants')
        .select('id, company_name, slug, exact_subdomain, status, created_at')
        .order('created_at', { ascending: true });
      const audit = await client.from('audit_logs').select('id, action, entity_type, entity_id, actor_label, created_at').limit(20);
      const releases = await client.from('releases').select('id, version, git_sha, artifact_sha256, created_at').limit(20);
      const alerts = await client.from('alerts').select('id, tenant_id, severity, code, created_at').limit(20);

      if (cancelled) return;
      setData({
        loading: false,
        tenants: (tenants.data ?? []).map((row) => ({
          id: row.id,
          companyName: row.company_name,
          slug: row.slug,
          exactSubdomain: row.exact_subdomain,
          status: row.status,
          createdAt: row.created_at,
        })),
        auditEvents: (audit.data ?? []).map((row) => ({
          id: row.id,
          action: row.action,
          entityType: row.entity_type,
          entityId: row.entity_id,
          actorLabel: row.actor_label,
          createdAt: row.created_at,
        })),
        releases: (releases.data ?? []).map((row) => ({
          id: row.id,
          version: row.version,
          gitSha: row.git_sha ?? null,
          artifactSha256: row.artifact_sha256 ?? null,
          createdAt: row.created_at,
        })),
        alerts: (alerts.data ?? []).map((row) => ({
          id: row.id,
          tenantId: row.tenant_id ?? null,
          severity: row.severity,
          code: row.code,
          createdAt: row.created_at,
        })),
      });
      setLoading(false);
    })().catch(() => {
      if (!cancelled) {
        setData(EMPTY);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [productionMode]);

  return { ...data, loading };
}

/** Preview-only sample rows (DEV). Production never receives these. */
export function useSampleTenantsForPreview() {
  return sampleTenants;
}
