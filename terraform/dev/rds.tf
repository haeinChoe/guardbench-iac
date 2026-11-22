resource "aws_db_subnet_group" "app" {
  name       = "${var.project}-${var.environment}-db-subnets"
  subnet_ids = data.terraform_remote_state.shared.outputs.private_subnet_ids

  tags = {
    Name = "${var.project}-${var.environment}-db-subnets"
  }
}

resource "aws_db_instance" "app" {
  identifier = "${var.project}-${var.environment}"

  engine         = "postgres"
  engine_version = "16.14"
  instance_class = var.dev_db_instance_class
  db_name        = "guardbench"
  username       = "guardbench"

  manage_master_user_password = true
  storage_encrypted           = true
  storage_type                = "gp3"
  allocated_storage           = var.dev_db_allocated_storage
  max_allocated_storage       = var.dev_db_max_allocated_storage

  db_subnet_group_name   = aws_db_subnet_group.app.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period    = var.dev_db_backup_retention_period
  auto_minor_version_upgrade = true
  deletion_protection        = false
  skip_final_snapshot        = true

  tags = {
    Name = "${var.project}-${var.environment}-postgres"
  }
}
