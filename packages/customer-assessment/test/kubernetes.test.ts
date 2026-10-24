import { describe, expect, it } from 'vitest';
import { classifyKubernetesCandidate, findKubernetesCorrectionLocation } from '../src/kubernetes.js';

const pod = (property: string) => `apiVersion: v1\nkind: Pod\nmetadata:\n  name: customer\nspec:\n  containers:\n    - name: app\n      securityContext:\n        ${property}\n`;

describe('bounded Kubernetes candidate parsing',()=>{
  it('distinguishes Kubernetes documents from ordinary JSON and lockfiles',()=>{
    expect(classifyKubernetesCandidate('package-lock.json',JSON.stringify({name:'customer',lockfileVersion:3,packages:{}}))).toEqual({candidate:false,unrecognized:false});
    expect(classifyKubernetesCandidate('workload.json',JSON.stringify({apiVersion:'v1',kind:'Pod'}))).toEqual({candidate:true,unrecognized:false});
    expect(classifyKubernetesCandidate('multi.yaml','apiVersion: v1\nkind: ConfigMap\n---\napiVersion: apps/v1\nkind: Deployment\n')).toEqual({candidate:true,unrecognized:false});
  });

  it('keeps malformed but recognizable YAML as unknown',()=>{
    expect(classifyKubernetesCandidate('broken.yaml','apiVersion: v1\nkind: Pod\nspec: [unclosed\n')).toEqual({candidate:true,unrecognized:true});
    expect(classifyKubernetesCandidate('ordinary.yaml','metadata:\n  name: customer\n')).toEqual({candidate:false,unrecognized:false});
  });

  it('caps document parsing and leaves plausible overflow unknown',()=>{
    const content=Array.from({length:101},()=> '---\napiVersion: v1\nkind: Pod\n').join('');
    expect(classifyKubernetesCandidate('many.yaml',content)).toEqual({candidate:true,unrecognized:true});
  });

  it('refuses ambiguous, out-of-range, malformed, and unsupported bindings',()=>{
    const duplicate=pod('privileged: true\n        privileged: true');
    expect(findKubernetesCorrectionLocation(duplicate,'KSV017',7,10)).toBeUndefined();
    expect(findKubernetesCorrectionLocation(pod('privileged: true'),'KSV017',1,8)).toBeUndefined();
    expect(findKubernetesCorrectionLocation(pod('privileged: true'),'KSV017',1,502)).toBeUndefined();
    expect(findKubernetesCorrectionLocation('apiVersion: v1\nkind: Pod\nspec: [unclosed\n','KSV017',1,3)).toBeUndefined();
    expect(findKubernetesCorrectionLocation(pod('privileged: true'),'KSV118',7,9)).toBeUndefined();
  });
});
