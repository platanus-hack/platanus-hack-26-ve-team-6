import { createContext, useContext, type ReactNode } from 'react';
import { redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { customerScopeSchema } from '@gotchu/contracts';
import { customerApi } from './customer-client';
import type { DashboardPage } from './customer-dashboard';

export async function requireSignedIn() {
  // Initial SSR has no browser-origin API client. The dashboard repeats this check after hydration.
  if (typeof window === 'undefined') return;
  const session = await customerApi.session();
  if (!session.user) throw redirect({ to: '/entrar' });
}

export function validateWorkspaceParams(params: unknown) {
  return z.object({ workspaceId: z.uuid() }).parse(params);
}

export function validateProjectParams(params: unknown) {
  return customerScopeSchema.parse({
    organizationId: z.object({ workspaceId: z.uuid() }).parse(params).workspaceId,
    applicationId: z.object({ projectId: z.uuid() }).parse(params).projectId,
  });
}

export const DashboardSectionContext = createContext<() => ReactNode>(() => null);

export function routePageFromPath(pathname: string): { page: DashboardPage; applicationId?: string; reportId?: string } {
  const match = pathname.match(/^\/w\/[^/]+(?:\/p\/([^/]+))?(.*)$/);
  const applicationId = match?.[1];
  const section = (match?.[2] ?? '').replace(/\/$/, '');
  if (section === '/https') return { page: 'https-audit', ...(applicationId ? { applicationId } : {}) };
  if (section === '/fuentes') return { page: 'applications', ...(applicationId ? { applicationId } : {}) };
  if (section === '/vigilancia') return { page: 'operations', ...(applicationId ? { applicationId } : {}) };
  if (section === '/informes' || section.startsWith('/informes/')) {
    const reportId = section.match(/^\/informes\/([^/]+)$/)?.[1];
    return { page: 'reports', ...(applicationId ? { applicationId } : {}), ...(reportId ? { reportId } : {}) };
  }
  if (section === '/modelos') return { page: 'investigation-model' };
  if (section === '/asistentes') return { page: 'assistants' };
  if (section === '/licencias') return { page: 'license-policy', ...(applicationId ? { applicationId } : {}) };
  if (section === '/retencion') return { page: 'retention-policy', ...(applicationId ? { applicationId } : {}) };
  if (section === '/equipo') return { page: 'members', ...(applicationId ? { applicationId } : {}) };
  if (section === '/decisiones') return { page: 'decision-records', ...(applicationId ? { applicationId } : {}) };
  return { page: 'overview', ...(applicationId ? { applicationId } : {}) };
}

export function DashboardRouteView() {
  return useContext(DashboardSectionContext)();
}
