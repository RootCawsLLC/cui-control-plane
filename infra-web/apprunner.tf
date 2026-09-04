resource "aws_apprunner_service" "app" {
  count        = var.deploy_service ? 1 : 0
  service_name = var.project

  source_configuration {
    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_access.arn
    }
    auto_deployments_enabled = false

    image_repository {
      image_identifier      = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
      image_repository_type = "ECR"

      image_configuration {
        port = "3230"
        runtime_environment_variables = {
          NODE_ENV            = "production"
          CCP_ASSERTIONS_DIR  = "/repo/web/fixtures/assertions"
        }
      }
    }
  }

  instance_configuration {
    cpu    = var.app_cpu
    memory = var.app_memory
    # No instance role: the app calls no AWS APIs and contacts no real system. The
    # demo only spawns a node process that reads bundled synthetic fixtures.
  }

  network_configuration {
    egress_configuration {
      egress_type = "DEFAULT"
    }
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }
}
