"""PDF storage in S3 (Floci locally; an empty endpoint means real AWS)."""

import boto3
from botocore.config import Config

from config import settings

client = boto3.client(
    "s3",
    endpoint_url=settings.S3_ENDPOINT_URL or None,
    aws_access_key_id=settings.AWS_ACCESS_KEY_ID or None,
    aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY or None,
    region_name=settings.AWS_DEFAULT_REGION,
    config=Config(s3={"addressing_style": "path"}),
)


def put_pdf(key: str, data: bytes) -> None:
    client.put_object(
        Bucket=settings.S3_BUCKET, Key=key, Body=data, ContentType="application/pdf"
    )
