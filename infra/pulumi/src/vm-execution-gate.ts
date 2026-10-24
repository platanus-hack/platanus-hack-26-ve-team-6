export function assertCustomerCodeExecutionDisabled(enabled: boolean, vmIsolationDemonstrated: boolean): void {
  if (enabled && !vmIsolationDemonstrated) {
    throw new Error('Customer-code execution is disabled until disposable VM-class isolation is demonstrated and reviewed.');
  }
}
