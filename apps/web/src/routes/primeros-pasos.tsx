import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { customerApi } from '../components/customer-client';
import { Onboarding } from '../components/onboarding';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CustomerWorkspace } from '@gotchu/contracts';

const searchSchema = z.object({ espacio: z.uuid().optional(), fuente: z.enum(['github', 'carpeta', 'web']).optional() }).strict();

export const Route = createFileRoute('/primeros-pasos')({
  validateSearch: searchSchema,
  beforeLoad: async () => {
    if (typeof window !== 'undefined' && !(await customerApi.session()).user) throw redirect({ to: '/entrar' });
  },
  component: FirstStepsRoute,
});

function FirstStepsRoute() {
  const search = Route.useSearch();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string>();
  const session = useQuery({ queryKey: ['customer-session'], queryFn: customerApi.session, retry: false });
  if (session.isPending) return <main className="gl customer-app-shell"><p role="status">Comprobando tu sesión…</p></main>;
  const user = session.data?.user;
  if (!user) return <main className="gl customer-app-shell"><p>Inicia sesión para continuar.</p><a href="/entrar">Iniciar sesión</a></main>;
  return <Onboarding
    userId={user.id}
    {...(user.displayName ? { displayName: user.displayName } : {})}
    {...(search.espacio ? { organizationId: search.espacio } : {})}
    {...(search.fuente ? { initialSource: search.fuente } : {})}
    onWorkspaceCreated={(workspace: CustomerWorkspace) => {
      setCreatedWorkspaceId(workspace.id);
      void queryClient.invalidateQueries({ queryKey: ['customer-data', user.id, 'workspaces'] });
    }}
    onDone={({ organizationId, applicationId, jobId }) => {
      const key = ['customer-data', user.id, 'active-job'] as const;
      if (jobId) {
        const job = { organizationId, applicationId, jobId, purpose: 'assessment' as const };
        queryClient.setQueryData(key, job);
        window.localStorage.setItem(`gotchu.active-job.${user.id}`, JSON.stringify(job));
      } else {
        queryClient.setQueryData(key, null);
        window.localStorage.removeItem(`gotchu.active-job.${user.id}`);
      }
      void navigate({ to: '/w/$workspaceId/p/$projectId', params: { workspaceId: organizationId, projectId: applicationId } });
    }}
    onSkip={() => {
      window.sessionStorage.removeItem('gotchu-onboarding-scope');
      window.localStorage.setItem(`gotchu.onboarding-skipped.${user.id}`, 'true');
      const workspaceId = search.espacio ?? createdWorkspaceId ?? queryClient.getQueryData<CustomerWorkspace[]>(['customer-data', user.id, 'workspaces'])?.[0]?.id;
      if (workspaceId) void navigate({ to: '/w/$workspaceId', params: { workspaceId } });
      else void navigate({ to: '/dashboard' });
    }}
  />;
}
