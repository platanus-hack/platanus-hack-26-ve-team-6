import { randomUUID } from 'node:crypto';
import type { CustomerAssessmentReport, DependencyComponent } from '@gotchu/contracts';

const GOTCHU_VERSION = '0.1.0';

function componentProperties(component: DependencyComponent) {
  return [
    { name: 'gotchu:relationship', value: component.relationship },
    { name: 'gotchu:license-source', value: component.licenseSource },
    { name: 'gotchu:license-confidence', value: component.licenseConfidence },
    { name: 'gotchu:license-policy-status', value: component.policyStatus },
    { name: 'gotchu:source-file', value: component.sourceFile },
    ...(component.declaredLicense && component.licenseExpression === null
      ? [{ name: 'gotchu:declared-license-raw', value: component.declaredLicense }]
      : []),
  ];
}

function sbomComponent(component: DependencyComponent) {
  return {
    type: 'library',
    'bom-ref': component.purl,
    name: component.name,
    version: component.version,
    purl: component.purl,
    ...(component.licenseExpression ? { licenses: [{ expression: component.licenseExpression }] } : {}),
    properties: componentProperties(component),
  };
}

export function buildCycloneDx(report: CustomerAssessmentReport, createdAt = new Date()) {
  const inventory = report.internal?.dependencyInventory;
  const dependencyCoverage = report.internal?.coverage.find(item => item.capability === 'dependency_inventory')?.state;
  const licenseCoverage = report.internal?.coverage.find(item => item.capability === 'license_metadata')?.state;
  const componentsByPurl = new Map<string, DependencyComponent>();
  for (const component of inventory?.components ?? []) {
    const current = componentsByPurl.get(component.purl);
    if (!current) componentsByPurl.set(component.purl, { ...component, dependencies: [...component.dependencies] });
    else current.dependencies = [...new Set([...current.dependencies, ...component.dependencies])];
  }
  const components = [...componentsByPurl.values()].sort((left, right) => left.purl.localeCompare(right.purl));
  const applicationRef = `urn:gotchu:application:${report.applicationId}`;
  const direct = components.filter(component => component.relationship === 'direct').map(component => component.purl).sort();
  const dependencies = [
    { ref: applicationRef, dependsOn: direct },
    ...components.map(component => ({
      ref: component.purl,
      dependsOn: [...new Set(component.dependencies.filter(value => componentsByPurl.has(value)))].sort(),
    })),
  ];
  const complete = Boolean(inventory?.complete && inventory.graphComplete && dependencyCoverage === 'inspected' && licenseCoverage === 'inspected');
  const sourceDigest = report.subject.sourceDigest;
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: createdAt.toISOString(),
      tools: { components: [{ type: 'application', name: 'Gotchu', version: GOTCHU_VERSION }] },
      component: { type: 'application', 'bom-ref': applicationRef, name: report.applicationName },
      properties: [
        { name: 'gotchu:report-id', value: report.id },
        { name: 'gotchu:assessed-snapshot-sha256', value: sourceDigest ?? 'unavailable' },
        { name: 'gotchu:inventory-complete', value: String(Boolean(inventory?.complete)) },
        { name: 'gotchu:dependency-graph-complete', value: String(Boolean(inventory?.graphComplete)) },
        { name: 'gotchu:license-metadata-complete', value: String(licenseCoverage === 'inspected') },
      ],
    },
    components: components.map(sbomComponent),
    dependencies,
    compositions: [{ aggregate: complete ? 'complete' : 'incomplete', assemblies: [applicationRef] }],
  };
}
