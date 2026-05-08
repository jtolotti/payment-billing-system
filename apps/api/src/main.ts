import { NestFactory } from '@nestjs/core'
import { ValidationPipe, Logger } from '@nestjs/common'
import { json, urlencoded } from 'express'
import { AppModule } from './app.module'

/**
 * Bootstrap the API server.
 *
 * Raw body parsing is enabled on webhook paths so HMAC signature verification
 * can hash the exact bytes the gateway sent. JSON parsing still applies to
 * the rest of the routes.
 */
async function bootstrap() {
  const logger = new Logger('Bootstrap')

  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
  })

  // Raw body on webhook paths (for HMAC signature verification)
  // JSON body everywhere else.
  app.use(
    json({
      limit: '1mb',
      verify: (req: any, _res, buf) => {
        if (req.url?.includes('/webhooks/')) {
          req.rawBody = Buffer.from(buf)
        }
      },
    })
  )
  app.use(urlencoded({ extended: true }))

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    })
  )

  app.enableCors({
    origin: true,
    credentials: true,
  })

  const port = parseInt(process.env.API_PORT || '4000', 10)
  await app.listen(port)
  logger.log(`API listening on http://localhost:${port}`)
}

bootstrap()
