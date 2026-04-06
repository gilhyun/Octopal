interface OpenFolderModalProps {
  onPickFolder: () => void
}

export function OpenFolderModal({ onPickFolder }: OpenFolderModalProps) {
  return (
    <div className="modal-backdrop modal-backdrop--blocking">
      <div className="modal open-folder-modal">
        <div className="welcome-desc" style={{ marginTop: 4 }}>
          Open a project folder to get started.
        </div>
        <button className="btn-primary welcome-cta" onClick={onPickFolder}>
          Open Folder
        </button>
      </div>
    </div>
  )
}
