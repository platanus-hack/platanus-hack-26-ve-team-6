import { z } from 'zod';
import type { AssessmentAnalysis, AssessmentFinding, CustomerRunInput } from '@gotchu/contracts';
import { analysis, bounded, evidence, finding, finish } from './common.js';
import type { ScannerAdapter } from './docker.js';

const severityMap = { UNKNOWN: 'unknown', LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' } as const;
const vulnerabilitySchema = z.object({
  VulnerabilityID: z.string().min(1).max(128), PkgName: z.string().min(1).max(256),
  InstalledVersion: z.string().max(256), FixedVersion: z.string().max(512).optional(),
  Severity: z.enum(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  Title: z.string().max(512).optional(), Description: z.string().max(4000).optional(), PrimaryURL: z.string().max(2048).optional(),
  PkgIdentifier: z.object({ PURL: z.string().max(1024).optional() }).passthrough().optional(),
  Layer: z.object({ Digest: z.string().max(128).optional(), DiffID: z.string().max(128).optional() }).passthrough().optional(),
}).passthrough();
const resultSchema = z.object({
  Target: z.string().max(1024), Class: z.string().max(128).optional(), Type: z.string().max(128).optional(),
  Vulnerabilities: z.array(vulnerabilitySchema).max(20_000).nullable().optional(),
}).passthrough();
const trivyImageSchema = z.object({
  SchemaVersion: z.number().int(), ArtifactName: z.string().max(1024).optional(), ArtifactType: z.string().max(128).optional(),
  Metadata: z.object({
    ImageID: z.string().max(256).optional(), RepoTags: z.array(z.string().max(512)).max(100).optional(),
    RepoDigests: z.array(z.string().max(512)).max(100).optional(), DiffIDs: z.array(z.string().max(256)).max(1000).optional(),
    OS: z.object({ Family: z.string().max(128).optional(), Name: z.string().max(256).optional() }).passthrough().optional(),
  }).passthrough().optional(),
  Results: z.array(resultSchema).max(10_000).optional(),
}).passthrough();

function severity(value: z.infer<typeof vulnerabilitySchema>['Severity']): AssessmentFinding['severity'] {
  return severityMap[value];
}

function imageSnapshotRef(image: NonNullable<CustomerRunInput['containerImage']>) {
  return `container-image:sha256:${image.digest}`;
}

function vulnerabilityFindings(output: unknown) {
  const report = trivyImageSchema.parse(output);
  const results = report.Results ?? [];
  const vulnerabilities = results.flatMap(result => (result.Vulnerabilities ?? []).map(vulnerability => ({ result, vulnerability })));
  return { report, results, vulnerabilities };
}

export async function assessContainerImage(input: CustomerRunInput, signal: AbortSignal, scanners: ScannerAdapter): Promise<AssessmentAnalysis> {
  const image = input.containerImage;
  if (!image) throw new Error('missing_container_image');
  if (!scanners.runImage) throw new Error('container_image_scanner_unavailable');

  const a = analysis('internal', imageSnapshotRef(image));
  a.limitations.push(
    'Trivy analyzes the immutable image archive without starting or executing its contents. Registry bytes are fetched by digest from an allowlisted public registry; scanner containers have no network access.',
    'CVE matches indicate vulnerable package versions in image layers. They do not establish that the image is deployed, reachable, or exploited.',
    'Unsupported operating systems and package ecosystems remain unknown; a missing vulnerability finding is not evidence of safety.',
  );
  const runImage = scanners.runImage;
  if (!runImage) throw new Error('container_image_scanner_unavailable');
  const result = await bounded(() => runImage(image, signal), signal);
  const { report, results, vulnerabilities } = vulnerabilityFindings(result.output);
  if (image.kind === 'registry') {
    const digests = report.Metadata?.RepoDigests ?? [];
    if (digests.length > 0 && !digests.some(value => value.endsWith(`@sha256:${image.digest}`))) throw new Error('container_image_digest_mismatch');
  }

  const db = result.database;
  evidence(a, 'configuration', 'scanner-profile:trivy-image', {
    image: result.image, profileChecksum: result.profileChecksum, requestedDigest: image.digest,
    inputKind: image.kind, artifactName: report.ArtifactName ?? null,
    imageID: report.Metadata?.ImageID ?? null, repoDigests: report.Metadata?.RepoDigests ?? [],
    diffIDs: report.Metadata?.DiffIDs ?? [], osFamily: report.Metadata?.OS?.Family ?? null,
    osName: report.Metadata?.OS?.Name ?? null, vulnerabilityDatabase: db ?? null,
    matched: vulnerabilities.length, scannedTargets: results.length,
  }, { name: 'trivy', version: result.version });
  a.coverage.push({
    capability: 'container_image_trivy_profile', state: 'inspected',
    detail: `Trivy ${result.version} evaluó la imagen por digest con el perfil de vulnerabilidades ${result.profileChecksum}; la base estándar ${db?.ociDigest ?? 'no está verificada'} se lee sin red. La base de índice Java no se descarga en este perfil.`,
  });

  let truncated = false;
  for (const { result: target, vulnerability } of vulnerabilities) {
    if (a.findings.length >= 75 || a.evidence.length >= 150) { truncated = true; break; }
    const fixedVersion = vulnerability.FixedVersion?.trim() || null;
    const layer = vulnerability.Layer ? {
      digest: vulnerability.Layer.Digest ?? null,
      diffId: vulnerability.Layer.DiffID ?? null,
    } : null;
    const packageUrl = vulnerability.PkgIdentifier?.PURL ?? null;
    const locator = `${target.Target}:${vulnerability.PkgName}@${vulnerability.InstalledVersion}`.slice(0, 1_024);
    const evidenceId = evidence(a, 'dependency', locator, {
      vulnerabilityId: vulnerability.VulnerabilityID,
      package: vulnerability.PkgName,
      packageUrl,
      installedVersion: vulnerability.InstalledVersion,
      fixedVersion,
      ecosystem: target.Type ?? 'unknown',
      packageClass: target.Class ?? 'unknown',
      layer,
      imageDigest: image.digest,
    }, { name: 'trivy', version: result.version });
    const packageClass = target.Class === 'os-pkgs' ? 'OS' : 'lenguaje';
    finding(a, {
      ruleId: vulnerability.VulnerabilityID,
      correlationKey: `container:${target.Type ?? 'unknown'}:${vulnerability.PkgName}:${vulnerability.VulnerabilityID}`.slice(0, 512),
      title: `${vulnerability.VulnerabilityID}: ${vulnerability.PkgName}`.slice(0, 256),
      location: locator,
      description: vulnerability.Description ?? vulnerability.Title ?? `${vulnerability.VulnerabilityID} afecta a la versión de paquete observada por Trivy.`,
      severity: severity(vulnerability.Severity), confidence: 'observed',
      impact: `Trivy identificó un paquete de ${packageClass} ${vulnerability.PkgName}@${vulnerability.InstalledVersion} en el inventario de la imagen. El uso, despliegue y exposición del componente son desconocidos.`,
      recommendation: fixedVersion
        ? `Actualiza ${vulnerability.PkgName} a ${fixedVersion} o una versión posterior compatible y vuelve a evaluar la imagen.`
        : `Consulta ${vulnerability.PrimaryURL ?? vulnerability.VulnerabilityID}; la base de datos fijada no informó una versión corregida.`,
      limitations: ['Versión vulnerable observada en la imagen; no demuestra que el contenedor se ejecute o que el CVE sea explotable en este entorno.', 'La evidencia de capa identifica el origen de bytes cuando Trivy la proporciona; una capa posterior puede sustituir o borrar archivos.'],
      evidenceIds: [evidenceId],
    });
  }

  const osTargets = results.filter(target => target.Class === 'os-pkgs');
  const languageTargets = results.filter(target => target.Class === 'lang-pkgs');
  const hasSupportedType = (type: string | undefined) => Boolean(type) && !['unknown', 'unrecognized'].includes(type?.toLowerCase() ?? '');
  const osSupported = osTargets.length > 0 && osTargets.every(target => hasSupportedType(target.Type));
  a.coverage.push({
    capability: 'container_image_os_cves',
    state: osSupported ? 'inspected' : 'unavailable',
    detail: osSupported
      ? `Trivy inspeccionó ${osTargets.length} inventario(s) de paquetes del sistema (${[...new Set(osTargets.map(target => target.Type).filter((value): value is string => Boolean(value)))].join(', ')}). Las distribuciones no reconocidas o ausentes siguen siendo desconocidas.`
      : `Trivy identificó ${osTargets.length} inventario(s) de paquetes del sistema, pero no confirmó una distribución compatible para todos; la cobertura CVE del sistema operativo es desconocida${report.Metadata?.OS?.Name ? ` (${report.Metadata.OS.Name})` : ''}.`,
  });
  const languageSupported = languageTargets.length > 0 && languageTargets.every(target => hasSupportedType(target.Type));
  a.coverage.push({
    capability: 'container_image_language_cves',
    state: languageSupported ? 'inspected' : 'unavailable',
    detail: languageSupported
      ? `Trivy inspeccionó ${languageTargets.length} inventario(s) de paquetes de lenguaje (${[...new Set(languageTargets.map(target => target.Type).filter((value): value is string => Boolean(value)))].join(', ')}). Los ecosistemas sin inventario detectado permanecen desconocidos.`
      : `Trivy identificó ${languageTargets.length} inventario(s) de paquetes de lenguaje, pero no confirmó ecosistemas compatibles para todos; los CVE de lenguaje permanecen desconocidos.`,
  });
  a.coverage.push({
    capability: 'container_image_java_cves', state: 'unavailable',
    detail: result.database?.javaDatabaseAvailable === false
      ? 'La base de índice Java de Trivy no se descarga en esta iteración; los CVE de paquetes Java permanecen desconocidos aunque se detecte un JAR.'
      : 'La cobertura de CVE para paquetes Java no está verificada.',
  });
  a.coverage.push({
    capability: 'container_image_vulnerability_database',
    state: db ? 'inspected' : 'unavailable',
    detail: db ? `Se usó la base de datos OCI fijada ${db.ociDigest} (actualizada ${db.updatedAt}); el escaneo de imagen no tuvo acceso de red.` : 'No hay procedencia verificada de la base de datos CVE; la cobertura permanece desconocida.',
  });
  if (truncated) a.coverage.push({ capability: 'container_image_finding_limit', state: 'unavailable', detail: 'Se alcanzó el límite de hallazgos; las vulnerabilidades adicionales son desconocidas.' });
  return finish(a);
}
