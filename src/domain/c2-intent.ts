import { type Intent, IntentSchema } from '@nerima-games/mc-sim'
import { Result, Schema } from 'effect'

export const decodeC2Intent = (input: unknown): Intent | undefined => {
  const decoded = Schema.decodeUnknownResult(IntentSchema)(input)
  if (Result.isFailure(decoded)) {
    return undefined
  }
  return decoded.success
}
