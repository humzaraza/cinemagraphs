'use client'

import { useState } from 'react'
import Image from 'next/image'

interface Props {
  currentName: string
  currentUsername: string
  currentBio: string
  currentImage: string
  onClose: () => void
  onSaved: () => void
}

export default function EditProfileModal({
  currentName,
  currentUsername,
  currentBio,
  currentImage,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState(currentName)
  const [username, setUsername] = useState(currentUsername)
  const [bio, setBio] = useState(currentBio)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState(currentImage)
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const usernameValid = username === '' || /^[a-zA-Z0-9_]{3,20}$/.test(username)

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setErrorMsg('Only JPG and PNG files are allowed.')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setErrorMsg('Image must be under 2MB.')
      return
    }

    setImageFile(file)
    setImagePreview(URL.createObjectURL(file))
    setErrorMsg('')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!usernameValid) return

    setStatus('saving')
    setErrorMsg('')

    try {
      // If there's a new image, upload it first
      let imageUrl = currentImage
      if (imageFile) {
        const formData = new FormData()
        formData.append('file', imageFile)
        const uploadRes = await fetch('/api/user/avatar', { method: 'POST', body: formData })
        if (!uploadRes.ok) {
          const data = await uploadRes.json()
          throw new Error(data.error || 'Failed to upload image')
        }
        const data = await uploadRes.json()
        imageUrl = data.url
      }

      // Only send fields that changed
      const payload: Record<string, string | null> = {
        name: name.trim() || null,
        username: username.trim() || null,
        bio: bio.trim() || null,
      }
      // Only include image if the user uploaded a new one
      if (imageFile) {
        payload.image = imageUrl || null
      }

      const res = await fetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to update profile')
      }

      onSaved()
    } catch (err) {
      setErrorMsg((err as Error).message)
      setStatus('error')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-md bg-cinema-darker border border-cinema-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-cinema-border">
          <h2 className="font-[family-name:var(--font-playfair)] text-lg font-bold text-cinema-cream">
            Edit Profile
          </h2>
          <button
            onClick={onClose}
            className="text-cinema-muted hover:text-cinema-cream transition-colors"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <div className="relative w-16 h-16 rounded-full overflow-hidden bg-cinema-card flex-shrink-0">
              {imagePreview ? (
                <Image src={imagePreview} alt="Avatar" fill className="object-cover" />
              ) : (
                <div
                  className="w-full h-full flex items-center justify-center text-2xl font-bold"
                  style={{ background: 'linear-gradient(135deg, #C8A951, #a08530)', color: '#0D0D1A' }}
                >
                  {(name || 'U')[0].toUpperCase()}
                </div>
              )}
            </div>
            <label className="text-sm text-cinema-gold cursor-pointer hover:underline">
              Change photo
              <input
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                onChange={handleImageChange}
              />
            </label>
          </div>

          {/* Display Name */}
          <div>
            <label className="block text-sm text-cinema-muted mb-1">Display Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={50}
              className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-3 py-2.5 text-sm text-cinema-cream placeholder:text-cinema-muted/50 focus:outline-none focus:border-cinema-gold/50"
              placeholder="Your name"
            />
          </div>

          {/* Username */}
          <div>
            <label className="block text-sm text-cinema-muted mb-1">Username</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-cinema-muted text-sm">@</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                maxLength={20}
                className={`w-full bg-cinema-dark border rounded-lg pl-7 pr-3 py-2.5 text-sm text-cinema-cream placeholder:text-cinema-muted/50 focus:outline-none ${
                  !usernameValid ? 'border-red-500' : 'border-cinema-border focus:border-cinema-gold/50'
                }`}
                placeholder="username"
              />
            </div>
            {!usernameValid && (
              <p className="text-xs text-red-400 mt-1">3-20 characters, letters, numbers, underscores only</p>
            )}
          </div>

          {/* Bio */}
          <div>
            <label className="block text-sm text-cinema-muted mb-1">Bio</label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={160}
              rows={3}
              className="w-full bg-cinema-dark border border-cinema-border rounded-lg px-3 py-2.5 text-sm text-cinema-cream placeholder:text-cinema-muted/50 focus:outline-none focus:border-cinema-gold/50 resize-none"
              placeholder="Tell us about yourself..."
            />
            <p className="text-xs text-cinema-muted text-right">{bio.length}/160</p>
          </div>

          {/* Error */}
          {errorMsg && (
            <p className="text-sm text-red-400">{errorMsg}</p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={status === 'saving' || !usernameValid}
            className="w-full py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-cinema-gold text-cinema-dark hover:bg-cinema-gold/90"
          >
            {status === 'saving' ? 'Saving...' : 'Save Changes'}
          </button>
        </form>
      </div>
    </div>
  )
}
