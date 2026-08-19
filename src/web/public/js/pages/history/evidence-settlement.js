export function classifyHistoryEvidence(evidence) {
  if (!evidence) {
    return {
      text: '本地服务暂无该动作的证据记录;操作可能没有执行,请核对实际状态。',
      tone: 'warn',
      verified: false,
    };
  }
  const committed = evidence.local_action_committed === true;
  const explicitlyVerified = evidence.verified === true
    || evidence.clipboard_verified === true
    || evidence.evidence_verified === true
    || String(evidence.verification_status || '') === 'verified'
    || String(evidence.status || '') === 'verified';
  const afterReason = String(evidence.local_action_after_commit_reason || '').trim();
  if (committed && explicitlyVerified && !afterReason) {
    return { text: '证据显示:操作已提交并核验通过。', tone: 'ok', verified: true };
  }
  if (committed) {
    return {
      text: `证据显示:操作已提交,但未完全核验${afterReason ? `(${evidence.local_action_after_commit_error || afterReason})` : ''};请查看实际结果。`,
      tone: 'warn',
      verified: false,
    };
  }
  return { text: '证据显示:操作未完成提交;可在核对后重试。', tone: 'warn', verified: false };
}

export function createHistoryEvidenceLifecycle({ isPageActive = () => true } = {}) {
  let active = true;
  let operation = 0;
  let verifiedClaimed = false;

  const accepts = candidate => {
    if (!active || candidate !== operation) return false;
    try {
      return isPageActive() !== false;
    } catch {
      return false;
    }
  };

  return {
    begin() {
      operation += 1;
      return operation;
    },
    accepts,
    claimVerified(candidate, evidence) {
      if (verifiedClaimed || !accepts(candidate) || !classifyHistoryEvidence(evidence).verified) return false;
      verifiedClaimed = true;
      return true;
    },
    close() {
      active = false;
      operation += 1;
    },
  };
}
