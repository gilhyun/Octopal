import { useTranslation } from 'react-i18next'
import { ShieldAlert, ShieldX, FileText, FolderOpen } from 'lucide-react'

export type FileAccessDecision = 'allow_once' | 'allow_always' | 'deny'

interface FileAccessApprovalModalProps {
  /** The agent requesting access */
  agentName: string
  /** The file or directory path being accessed */
  targetPath: string
  /** Why the agent wants access */
  reason?: string
  /** Whether the path is on the blacklist (no approval possible) */
  blocked?: boolean
  /** Callback with the user's decision */
  onDecision: (decision: FileAccessDecision) => void
  /** Close handler (only for blocked variant) */
  onClose?: () => void
}

export function FileAccessApprovalModal({
  agentName,
  targetPath,
  reason,
  blocked = false,
  onDecision,
  onClose,
}: FileAccessApprovalModalProps) {
  const { t } = useTranslation()

  // Blocked path — no approval options, just an alert
  if (blocked) {
    return (
      <div className="modal-backdrop modal-backdrop--blocking">
        <div
          className="modal file-access-modal file-access-modal--blocked"
          role="alertdialog"
          aria-labelledby="file-access-title"
          aria-describedby="file-access-desc"
        >
          <div className="file-access-modal__icon file-access-modal__icon--blocked">
            <ShieldX size={32} />
          </div>
          <h2 id="file-access-title" className="modal-title" style={{ marginBottom: 4 }}>
            {t('security.blocked')}
          </h2>
          <p id="file-access-desc" className="file-access-modal__desc">
            {t('security.blockedDesc')}
          </p>
          <div className="file-access-modal__path file-access-modal__path--blocked">
            <FileText size={14} />
            <code>{targetPath}</code>
          </div>
          <div className="modal-actions">
            <button className="btn-primary" onClick={onClose} autoFocus>
              {t('common.ok')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Normal approval flow — user can allow once, allow always, or deny
  const isDirectory = targetPath.endsWith('/')

  return (
    <div className="modal-backdrop modal-backdrop--blocking">
      <div
        className="modal file-access-modal"
        role="alertdialog"
        aria-labelledby="file-access-title"
        aria-describedby="file-access-desc"
      >
        <div className="file-access-modal__icon">
          <ShieldAlert size={32} />
        </div>
        <h2 id="file-access-title" className="modal-title" style={{ marginBottom: 4 }}>
          {t('security.accessRequest')}
        </h2>
        <p id="file-access-desc" className="file-access-modal__desc">
          {t('security.accessRequestDesc', { agent: agentName })}
        </p>

        <div className="file-access-modal__path">
          {isDirectory ? <FolderOpen size={14} /> : <FileText size={14} />}
          <code>{targetPath}</code>
        </div>

        {reason && (
          <div className="file-access-modal__reason">
            <span className="file-access-modal__reason-label">
              {t('security.reason')}
            </span>
            {reason}
          </div>
        )}

        <div className="file-access-modal__actions">
          <button
            className="btn-secondary"
            onClick={() => onDecision('deny')}
          >
            {t('security.deny')}
          </button>
          <button
            className="btn-secondary"
            onClick={() => onDecision('allow_always')}
          >
            {t('security.allowAlways')}
          </button>
          <button
            className="btn-primary"
            onClick={() => onDecision('allow_once')}
            autoFocus
          >
            {t('security.allowOnce')}
          </button>
        </div>
      </div>
    </div>
  )
}
