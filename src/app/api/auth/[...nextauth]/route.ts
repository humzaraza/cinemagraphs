import NextAuth from 'next-auth'
import { authOptions } from '@/lib/auth'

console.log('GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID)
console.log('NEXTAUTH_URL:', process.env.NEXTAUTH_URL)

const handler = NextAuth(authOptions)

export { handler as GET, handler as POST }
