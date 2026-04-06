import { useEffect } from 'react'
import confetti from 'canvas-confetti'

interface WelcomeModalProps {
  onPickFolder: () => void
}

export function WelcomeModal({ onPickFolder }: WelcomeModalProps) {
  useEffect(() => {
    // 모달 마운트 후 살짝 딜레이 → 폭죽!
    const timer = setTimeout(() => {
      // 왼쪽에서 발사
      confetti({
        particleCount: 60,
        angle: 60,
        spread: 55,
        origin: { x: 0.15, y: 0.6 },
        colors: ['#D44058', '#E8A0BF', '#FFD700', '#7B68EE', '#00CED1'],
        gravity: 0.8,
        ticks: 120,
        disableForReducedMotion: true,
      })
      // 오른쪽에서 발사
      confetti({
        particleCount: 60,
        angle: 120,
        spread: 55,
        origin: { x: 0.85, y: 0.6 },
        colors: ['#D44058', '#E8A0BF', '#FFD700', '#7B68EE', '#00CED1'],
        gravity: 0.8,
        ticks: 120,
        disableForReducedMotion: true,
      })
    }, 400)

    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="modal-backdrop modal-backdrop--blocking">
      <div className="modal welcome-modal">
        <div className="welcome-mascot welcome-mascot--lg">
          <img src="logo.png" alt="Octopal" className="welcome-mascot-img welcome-mascot-img--lg" />
        </div>
        <div className="welcome-title">Welcome to Octopal!</div>
        <div className="welcome-desc">
          Start by opening a project folder
          <br />
          to chat with your AI teammates.
        </div>
        <button className="btn-primary welcome-cta" onClick={onPickFolder}>
          Open Folder
        </button>
      </div>
    </div>
  )
}
