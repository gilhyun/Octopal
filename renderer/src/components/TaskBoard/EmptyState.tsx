interface EmptyStateProps {
  columnLabel?: string
  isBoard?: boolean
}

export function EmptyState({ columnLabel, isBoard = false }: EmptyStateProps) {
  if (isBoard) {
    return (
      <div className="task-empty-state task-empty-state--board">
        <div className="task-empty-state__icon" aria-hidden="true">📋</div>
        <h3 className="task-empty-state__title">No tasks yet</h3>
        <p className="task-empty-state__desc">
          Press <kbd>N</kbd> or click <strong>+ New Task</strong> to create your first task.
        </p>
      </div>
    )
  }

  return (
    <div className="task-empty-state task-empty-state--column">
      <p className="task-empty-state__hint">
        Drop tasks here to mark as {columnLabel}
      </p>
    </div>
  )
}
