import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import confetti from 'canvas-confetti'

interface WelcomeModalProps {
  onPickFolder: () => void
}

export function WelcomeModal({ onPickFolder }: WelcomeModalProps) {
  const { t } = useTranslation()

  useEffect(() => {
    const timer = setTimeout(() => {
      confetti({
        particleCount: 60,
        angle: 60,
        spread: 55,
        origin: { x: 0.15, y: 0.6 },
        colors: ['#B0A080', '#8AA898', '#C0A878', '#A89888', '#90A8A0'],
        gravity: 0.8,
        ticks: 120,
        disableForReducedMotion: true,
      })
      confetti({
        particleCount: 60,
        angle: 120,
        spread: 55,
        origin: { x: 0.85, y: 0.6 },
        colors: ['#B0A080', '#8AA898', '#C0A878', '#A89888', '#90A8A0'],
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
        <div className="welcome-title">{t('modals.welcome.title')}</div>
        <div className="welcome-desc">
          {t('modals.welcome.desc').split('\n').map((line, i) => (
            <span key={i}>{line}{i === 0 && <br />}</span>
          ))}
        </div>
        <button className="btn-primary welcome-cta" onClick={onPickFolder}>
          {t('modals.welcome.openFolder')}
        </button>
      </div>
    </div>
  )
}
